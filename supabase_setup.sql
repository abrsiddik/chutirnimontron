-- Resort Booking Manager: Supabase PostgreSQL schema
-- Run the entire file in Supabase Dashboard -> SQL Editor as project owner.
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  role text not null default 'staff' check (role in ('admin','staff')),
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_user_profile()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id,email,full_name,role)
  values(new.id,new.email,coalesce(new.raw_user_meta_data->>'full_name',''), 'staff')
  on conflict(id) do update set email=excluded.email;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile after insert on auth.users
for each row execute procedure public.handle_new_user_profile();

create table if not exists public.rooms (
  room_number integer primary key check(room_number between 1 and 16),
  category text not null default 'Standard',
  nightly_rate numeric(12,2) not null default 0 check(nightly_rate >= 0),
  active boolean not null default true
);
insert into public.rooms(room_number,category) select n,'Standard' from generate_series(1,16) n
on conflict(room_number) do nothing;

create table if not exists public.bookings (
  id text primary key,
  room integer not null references public.rooms(room_number),
  rooms integer[] not null default '{}',
  guest_name text not null check(length(trim(guest_name)) > 0),
  phone text not null default '',
  guest_type text not null default 'Family',
  check_in date not null,
  check_out date not null,
  nightly_rate numeric(12,2) not null default 0 check(nightly_rate >= 0),
  discount_amount numeric(12,2) not null default 0 check(discount_amount >= 0),
  total_amount numeric(12,2) not null default 0 check(total_amount >= 0),
  paid_amount numeric(12,2) not null default 0 check(paid_amount >= 0),
  status text not null default 'Booked' check(status in ('Booked','Tentative','Checked-in','Checked-out','Cancelled')),
  payment_note text not null default '',
  notes text not null default '',
  resort_name text not null default 'Resort Booking Manager',
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(check_out > check_in),
  check(cardinality(rooms) > 0),
  check(array_position(rooms,null) is null),
  check(array_length(rooms,1) <= 16)
);
create index if not exists bookings_dates_idx on public.bookings(check_in,check_out);
create index if not exists bookings_status_idx on public.bookings(status);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id text not null references public.bookings(id) on delete cascade,
  amount numeric(12,2) not null,
  payment_method text not null default '',
  note text not null default '',
  recorded_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create table if not exists public.booking_history (
  id bigint generated always as identity primary key,
  booking_id text not null,
  action text not null check(action in ('create','edit','reschedule','cancel')),
  changed_by uuid references auth.users(id),
  before_data jsonb,
  after_data jsonb not null,
  created_at timestamptz not null default now()
);

create or replace function public.current_user_role() returns text
language sql stable security definer set search_path=public
as $$ select role from public.profiles where id=auth.uid() $$;
revoke all on function public.current_user_role() from public;
grant execute on function public.current_user_role() to authenticated;

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.bookings enable row level security;
alter table public.payments enable row level security;
alter table public.booking_history enable row level security;

drop policy if exists "profile read own or admin" on public.profiles;
create policy "profile read own or admin" on public.profiles for select to authenticated
using (id = auth.uid() or public.current_user_role()='admin');
drop policy if exists "admin manage profiles" on public.profiles;
create policy "admin manage profiles" on public.profiles for update to authenticated
using (public.current_user_role()='admin')
with check (public.current_user_role()='admin');
drop policy if exists "authenticated read rooms" on public.rooms;
create policy "authenticated read rooms" on public.rooms for select to authenticated using(true);
drop policy if exists "admin manage rooms" on public.rooms;
create policy "admin manage rooms" on public.rooms for all to authenticated
using (public.current_user_role()='admin')
with check (public.current_user_role()='admin');
drop policy if exists "staff read bookings" on public.bookings;
create policy "staff read bookings" on public.bookings for select to authenticated
using (public.current_user_role() in ('admin','staff'));
drop policy if exists "staff read payments" on public.payments;
create policy "staff read payments" on public.payments for select to authenticated
using (public.current_user_role() in ('admin','staff'));
drop policy if exists "admin read history" on public.booking_history;
create policy "admin read history" on public.booking_history for select to authenticated
using (public.current_user_role()='admin');

create or replace function public.save_resort_booking(p_booking jsonb, p_action text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_id text := p_booking->>'id';
  v_rooms integer[];
  v_checkin date := (p_booking->>'check_in')::date;
  v_checkout date := (p_booking->>'check_out')::date;
  v_status text := coalesce(p_booking->>'status','Booked');
  v_before jsonb;
  v_after jsonb;
  v_old_paid numeric(12,2) := 0;
  v_new_paid numeric(12,2) := coalesce((p_booking->>'paid_amount')::numeric,0);
  v_delta numeric(12,2);
begin
  if v_uid is null then raise exception 'Sign-in required'; end if;
  v_role := public.current_user_role();
  if v_role not in ('admin','staff') then raise exception 'No permission to manage bookings'; end if;
  if v_id is null or length(trim(v_id))=0 then raise exception 'Booking ID is required'; end if;
  if v_checkin is null or v_checkout is null or v_checkout <= v_checkin then raise exception 'Check-out must be after check-in'; end if;
  if v_status not in ('Booked','Tentative','Checked-in','Checked-out','Cancelled') then raise exception 'Invalid booking status'; end if;
  select coalesce(array_agg(distinct value::integer order by value::integer),'{}'::integer[])
  into v_rooms from jsonb_array_elements_text(coalesce(p_booking->'rooms','[]'::jsonb)) as x(value);
  if cardinality(v_rooms)=0 then v_rooms := array[(p_booking->>'room')::integer]; end if;
  if exists(select 1 from unnest(v_rooms) r where r < 1 or r > 16) then raise exception 'Unknown room number'; end if;
  if (p_booking->>'guest_name') is null or length(trim(p_booking->>'guest_name'))=0 then raise exception 'Guest name is required'; end if;

  -- Serialize booking writes so concurrent staff cannot book the same room/date window.
  perform pg_advisory_xact_lock(hashtext('resort_booking_manager_room_inventory'));
  select to_jsonb(b), coalesce(b.paid_amount,0) into v_before,v_old_paid
  from public.bookings b where b.id=v_id for update;
  v_old_paid := coalesce(v_old_paid,0);
  if v_status <> 'Cancelled' then
    if exists(
      select 1 from public.bookings b
      cross join lateral unnest(b.rooms) as u(existing_room)
      where b.id <> v_id
        and b.status <> 'Cancelled'
        and b.check_in < v_checkout and b.check_out > v_checkin
        and u.existing_room = any(v_rooms)
    ) then raise exception 'Double booking blocked: one or more rooms are already booked for these dates'; end if;
  end if;

  insert into public.bookings(id,room,rooms,guest_name,phone,guest_type,check_in,check_out,nightly_rate,discount_amount,total_amount,paid_amount,status,payment_note,notes,resort_name,created_by,updated_by)
  values(v_id, v_rooms[1], v_rooms, trim(p_booking->>'guest_name'), coalesce(p_booking->>'phone',''), coalesce(p_booking->>'guest_type','Family'), v_checkin, v_checkout,
    coalesce((p_booking->>'nightly_rate')::numeric,0),coalesce((p_booking->>'discount_amount')::numeric,0),coalesce((p_booking->>'total_amount')::numeric,0),v_new_paid,v_status,
    coalesce(p_booking->>'payment_note',''),coalesce(p_booking->>'notes',''),coalesce(p_booking->>'resort_name','Resort Booking Manager'),v_uid,v_uid)
  on conflict(id) do update set room=excluded.room,rooms=excluded.rooms,guest_name=excluded.guest_name,phone=excluded.phone,guest_type=excluded.guest_type,
    check_in=excluded.check_in,check_out=excluded.check_out,nightly_rate=excluded.nightly_rate,discount_amount=excluded.discount_amount,total_amount=excluded.total_amount,
    paid_amount=excluded.paid_amount,status=excluded.status,payment_note=excluded.payment_note,notes=excluded.notes,resort_name=excluded.resort_name,updated_by=v_uid,updated_at=now();
  select to_jsonb(b) into v_after from public.bookings b where b.id=v_id;
  insert into public.booking_history(booking_id,action,changed_by,before_data,after_data)
  values(v_id,case when p_action in ('create','edit','reschedule','cancel') then p_action else 'edit' end,v_uid,v_before,v_after);
  v_delta := v_new_paid-v_old_paid;
  if v_delta <> 0 then
    insert into public.payments(booking_id,amount,payment_method,note,recorded_by)
    values(v_id,v_delta,coalesce(p_booking->>'payment_note',''),case when v_delta>0 then 'Payment amount increased via booking form' else 'Payment amount adjusted downward via booking form' end,v_uid);
  end if;
  return v_after;
end;
$$;
revoke all on function public.save_resort_booking(jsonb,text) from public;
grant execute on function public.save_resort_booking(jsonb,text) to authenticated;

-- Allow the Realtime publication to broadcast changes (safe to run repeatedly).
do $$ begin
  alter publication supabase_realtime add table public.bookings;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- After creating your first user in Authentication, replace their UUID below and run:
-- update public.profiles set role='admin' where id='YOUR-AUTH-USER-UUID';
