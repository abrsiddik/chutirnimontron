# Resort Booking Manager — Google Sheets sync setup

This package adds Google Sheets syncing for **create, edit, reschedule, and cancel**. It keeps the existing booking manager features and local browser storage unchanged. The Google Sheet receives one row per Booking ID in a `Booking Sync` tab; later edits update that same row rather than creating duplicates. A `Sync Log` tab records requests and errors.

## 1. Add the Apps Script to your existing spreadsheet

1. Open the **existing Google Spreadsheet** you want to use.
2. Choose **Extensions → Apps Script**. This is important: the script must be bound to that spreadsheet.
3. Replace the editor contents with the supplied `Code.gs` file and save.
4. In the first few lines, replace `REPLACE_WITH_A_LONG_RANDOM_SECRET` with a unique, hard-to-guess secret. Do not share it publicly.
5. In Apps Script, choose **Deploy → New deployment**.
6. Select **Web app** as the deployment type.
7. Set **Execute as: Me**. Set access to **Anyone** (the shared secret is checked by the script; your Google Workspace may restrict this choice).
8. Click **Deploy**, authorize the script, and copy the Web app URL ending in `/exec`.

## 2. Connect the HTML app

1. Open `resort_booking_manager_booking_management.html` in Safari/Chrome, preferably from your hosted website rather than a file preview.
2. Click **Settings & Sheets sync**.
3. Paste the deployed Web app URL and enter the exact same shared secret you set in `Code.gs`.
4. Click **Save settings**.
5. Click **Send test**. Check **Apps Script → Executions** and the spreadsheet's `Sync Log` tab for a `TEST` entry.
6. Create a test booking, edit it, change its dates/rooms, and cancel it. Confirm the same Booking ID is updated in `Booking Sync` and the `Last Action` column reflects the event.

## How sync works

- **Create:** inserts a row for a new Booking ID.
- **Edit:** updates the existing row for that Booking ID.
- **Reschedule:** updates the existing row when check-in, check-out, or selected rooms change.
- **Cancel:** updates the row with `Cancelled` status; it does not delete the record.
- Existing bookings are not bulk-uploaded automatically. Sync applies to changes made after setup.
- Booking records are still saved in the browser on the device where they were entered. Google Sheets is a copy of changes sent by that browser, not a replacement for the app's local storage or a multi-device database.
- Browser `no-cors` requests cannot read the Web App's response, so the app can indicate that a request was sent but cannot guarantee success from the browser UI. Verify first-time setup in `Sync Log` and `Apps Script → Executions`.

## Included files

- `resort_booking_manager_booking_management.html` — updated app
- `Code.gs` — Apps Script endpoint
- `README_Google_Sheets_Sync.md` — this guide
