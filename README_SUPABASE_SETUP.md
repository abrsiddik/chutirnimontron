# Resort Booking Manager — Supabase edition

This package keeps the existing calendar, room/day view, booking editor, filters, CSV export, JSON backup/restore, and optional Google Sheets sync. Supabase adds login, shared PostgreSQL storage, role-based policies, booking history, payment records, and real-time refresh.

## Files
- `index.html` — updated responsive app
- `supabase_setup.sql` — database schema, RLS policies, booking RPC and Realtime setup
- `Code.gs` — existing optional Google Apps Script Sheets integration
- `README_SUPABASE_SETUP.md` — this guide
- `README_Google_Sheets_Sync.md` — Sheets deployment instructions

## 1. Create/configure Supabase
1. Create a Supabase project on the Free plan (or use your existing project).
2. In **SQL Editor**, run all of `supabase_setup.sql`.
3. In **Project Settings → API**, copy the Project URL and the publishable key (or legacy anon key). Never use the `service_role` / secret key in the browser.
4. In **Authentication → Providers → Email**, enable Email/Password.
5. In **Authentication → Users**, create an account for the resort owner/admin and each staff member. Disable public sign-ups if you do not want self-registration.
6. After creating the first account, copy its user UUID from Authentication → Users and run this in SQL Editor:
   ```sql
   update public.profiles set role='admin' where id='PASTE-FIRST-ADMIN-USER-UUID';
   ```
   Newly created users default to `staff`. To promote another user, run the same statement with their UUID and role `'admin'`.
7. In **Database → Publications**, confirm `bookings` is included in `supabase_realtime` if your project did not allow the SQL file to add it automatically.

## 2. Run the app
1. Host `index.html` on HTTPS (Netlify, Cloudflare Pages, or another static host). A local file can be blocked by browser security/CDN restrictions; a hosted HTTPS origin is recommended.
2. Open the app. Enter the Project URL and publishable/anon key, then sign in with the account created in Supabase.
3. Admins can open **Settings & Sheets sync**. Staff can manage bookings but cannot access admin-only settings, backup/restore, or room catalog administration.
4. Configure Google Sheets separately in the same settings panel if you still want the previous Sheets sync. The Apps Script URL and secret remain independent from Supabase.

## 3. Configure room categories/rates
The 16 rooms are seeded as `Standard` with rate `0`. Edit the `rooms` table in Supabase Table Editor to set your actual room categories, nightly rates, and active flags. The dashboard room cards display those values for available rooms and the booking rate for occupied rooms. The booking form continues to accept a per-booking rate so existing pricing flexibility is preserved.

## 4. Security and double-booking protection
- Authentication is required to view the dashboard.
- `profiles.role` controls `admin` vs `staff` access. RLS policies protect tables.
- All booking writes use `save_resort_booking(...)`, a PostgreSQL function that takes a transaction-scoped advisory lock and checks overlapping room/date ranges before writing. Check-in is inclusive and check-out is exclusive.
- `Cancelled` bookings release room inventory. Other statuses remain in the booking history and continue to occupy their reserved date range, matching the existing app behavior.
- `booking_history` records create/edit/reschedule/cancel actions. `payments` records changes to the received amount made through the booking form; this is an audit trail, not a replacement for a dedicated itemized payment-entry screen.
- Real-time database changes refresh connected clients. A connected device needs an internet connection and an authenticated session.
- Browser storage is used only for UI settings and a local cache/backup. Shared bookings are read from and written to Supabase.

## 5. Existing local bookings
This version does not automatically upload old localStorage data because silently importing it could create duplicate IDs or room conflicts. Export a JSON backup from the old app and keep it safely. Import/migration should be planned before moving live staff to the shared app; test with a few bookings first. Google Sheets is an optional mirror, not the authoritative shared database.

## Troubleshooting
- **Profile missing:** run the SQL file, sign out/in, and check that the `profiles` trigger created a row for the user.
- **No permission:** verify the user has `staff` or `admin` in `public.profiles`.
- **Double booking blocked:** check the room and date range; checkout day is not occupied.
- **Realtime not refreshing:** confirm `bookings` is in `supabase_realtime`, then reload and sign in again.
- **Supabase client fails to load:** check internet access to `cdn.jsdelivr.net` or host the Supabase JS v2 library with your deployment.
