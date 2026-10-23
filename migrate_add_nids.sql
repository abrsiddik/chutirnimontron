-- Run once in Supabase SQL Editor for existing projects.
-- Adds optional multiple guest NID / ID numbers to bookings.

alter table public.bookings
  add column if not exists nids text[] not null default '{}';

create or replace function public.save_resort_booking(p_booking jsonb, p_action text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_id text := p_booking->>'id';
  v_rooms integer[];
  v_nids text[];
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
  select coalesce(array_agg(trim(value) order by ordinality),'{}'::text[])
  into v_nids
  from jsonb_array_elements_text(coalesce(p_booking->'nids','[]'::jsonb)) with ordinality as x(value, ordinality)
  where length(trim(value)) > 0;
  v_nids := coalesce(v_nids,'{}'::text[]);

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

  insert into public.bookings(id,room,rooms,guest_name,phone,guest_type,nids,check_in,check_out,nightly_rate,discount_amount,total_amount,paid_amount,status,payment_note,notes,resort_name,created_by,updated_by)
  values(v_id, v_rooms[1], v_rooms, trim(p_booking->>'guest_name'), coalesce(p_booking->>'phone',''), coalesce(p_booking->>'guest_type','Family'), v_nids, v_checkin, v_checkout,
    coalesce((p_booking->>'nightly_rate')::numeric,0),coalesce((p_booking->>'discount_amount')::numeric,0),coalesce((p_booking->>'total_amount')::numeric,0),v_new_paid,v_status,
    coalesce(p_booking->>'payment_note',''),coalesce(p_booking->>'notes',''),coalesce(p_booking->>'resort_name','Resort Booking Manager'),v_uid,v_uid)
  on conflict(id) do update set room=excluded.room,rooms=excluded.rooms,guest_name=excluded.guest_name,phone=excluded.phone,guest_type=excluded.guest_type,nids=excluded.nids,
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

revoke all on function public.save_resort_booking(jsonb,text) from public, anon;
grant execute on function public.save_resort_booking(jsonb,text) to authenticated;
