# Chutir Nimontron — Google Sheets reports setup

This integration syncs bookings from the website to Google Sheets and keeps **daily / monthly / dashboard** reports up to date. Supabase remains the live booking database; Sheets is a reporting mirror.

## Sheets created automatically

| Tab | Purpose |
|-----|---------|
| **All Bookings** | One row per Booking ID (upsert — no duplicates). Legacy tab `Booking Sync` is renamed to this name if present. |
| **Daily Report** | Per-date check-ins, check-outs, occupancy, allocated revenue/payments, dues |
| **Monthly Report** | Per-month bookings, revenue, payments, dues, occupancy %, cancellations |
| **Dashboard** | Today’s activity + this month’s financial summary |
| **Sync Log** | Request / error audit trail |

Reports rebuild after every create / edit / reschedule / cancel / payment sync, after **Sync all bookings** / **Rebuild reports**, and on a **daily scheduled** Apps Script trigger (once installed).

## 1. Install / update Apps Script

1. Open your **existing Google Spreadsheet** (or create one for reports).
2. **Extensions → Apps Script**.
3. Replace the project code with the latest `Code.gs` from this package. Save.
4. Set `SHARED_SECRET` near the top to a long random string. Use the **same** value in the booking app Settings. Do not commit real secrets to public repos.
5. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** (the script still checks the shared secret)
6. Authorize, then copy the Web App URL ending in `/exec`.
7. If you already had a deployment, use **Deploy → Manage deployments → Edit → New version** so the new report code goes live.
8. In the Apps Script editor, select function **`installScheduledRefresh`** → **Run** once (authorize if asked). This creates a daily ~01:00 rebuild in the script’s timezone.

## 2. Connect the website

1. Open the hosted booking app and sign in as **admin**.
2. Open **Settings & Sheets sync**.
3. Paste the Web App URL and the shared secret → **Save settings**.
4. Click **Send test**. In the spreadsheet, confirm:
   - `Sync Log` has a `TEST` row
   - Tabs **All Bookings**, **Daily Report**, **Monthly Report**, **Dashboard** exist
5. Click **Sync all bookings** once to push current Supabase-loaded bookings and rebuild reports.
6. Create or edit a booking, then confirm the same Booking ID updates in **All Bookings** and that Daily / Monthly / Dashboard refresh.

## How metrics are calculated

### Daily Report
- **Bookings / Check-ins:** non-cancelled bookings whose check-in date is that day  
- **Check-outs:** non-cancelled bookings whose check-out date is that day  
- **Occupied rooms:** rooms for stays where `check-in ≤ date < check-out` (matches the app calendar)  
- **Revenue / Payments received:** booking total and paid amount spread evenly across stay nights (the app does not store payment timestamps)  
- **Outstanding dues:** sum of remaining dues for bookings occupying rooms that night (operational snapshot)  
- **Occupancy %:** occupied rooms ÷ 16  

### Monthly Report
- **Total bookings:** non-cancelled bookings with check-in in that month  
- **Cancellations:** cancelled bookings with check-in in that month  
- **Booking revenue / Payments:** night-allocated amounts whose nights fall in that month  
- **Outstanding dues:** dues for bookings checking in that month  
- **Occupancy rate %:** room-nights sold ÷ (16 × days in month)  

### Dashboard
- Highlights **today** and **this month** using the same definitions, plus upcoming check-ins and overdue check-outs.

## Actions the website sends

| Action | When |
|--------|------|
| `create` / `edit` / `reschedule` / `cancel` / `payment` | After a successful booking save in the app |
| `test` | Settings → Send test |
| `sync_all` | Settings → Sync all bookings |
| `refresh_reports` | Settings → Rebuild reports |

Upserts always key on **Booking ID**. Editing never creates a second row for the same ID.

## Limits and honesty notes

- Browser requests use `no-cors`, so the app can only confirm that a request was **sent**, not that Google accepted it. Always verify **Sync Log** and **Apps Script → Executions** during setup.
- Existing history is **not** pushed until you run **Sync all bookings** (or individual edits after setup).
- Google Sheets is a **report mirror**, not the system of record. Supabase holds the live shared bookings.
- Do not put the shared secret or service-role keys in public HTML beyond what your deployment already requires; prefer keeping the secret only in Apps Script + admin browser settings.

## Included files

- `index.html` — booking app (Sheets settings + sync hooks)
- `Code.gs` — Apps Script Web App + report builders + scheduler
- `README_Google_Sheets_Sync.md` — this guide
