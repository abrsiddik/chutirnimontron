/**
 * Resort Booking Manager -> existing Google Spreadsheet
 * Install this script from Extensions > Apps Script in the EXISTING spreadsheet.
 * Replace SHARED_SECRET below with a long random string, then deploy as a Web App.
 */
const SHARED_SECRET = 'REPLACE_WITH_A_LONG_RANDOM_SECRET';
const BOOKINGS_SHEET_NAME = 'Booking Sync';
const LOG_SHEET_NAME = 'Sync Log';
const HEADERS = [
  'Booking ID', 'Resort', 'Room(s)', 'Guest Name', 'Phone', 'Booking Type',
  'Check-in', 'Check-out', 'Nights', 'Rate / Room / Night', 'Discount',
  'Total Amount', 'Received', 'Due', 'Status', 'Payment Note', 'Notes',
  'Last Action', 'Last Updated'
];

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const payload = JSON.parse(raw);
    if (!SHARED_SECRET || SHARED_SECRET === 'REPLACE_WITH_A_LONG_RANDOM_SECRET' || payload.secret !== SHARED_SECRET) {
      throw new Error('Unauthorized: shared secret does not match.');
    }
    if (payload.action === 'test') {
      appendLog_('TEST', '', 'Connection test received for ' + ((payload.booking || {}).resortName || 'Resort Booking Manager'));
      return json_({ ok: true, message: 'Test received' });
    }
    const allowed = ['create', 'edit', 'reschedule', 'cancel'];
    if (allowed.indexOf(payload.action) === -1) throw new Error('Unsupported action.');
    const b = payload.booking || {};
    if (!b.id) throw new Error('Booking ID is required.');

    lock.waitLock(20000);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) throw new Error('No spreadsheet is bound to this script. Open Apps Script from the existing spreadsheet.');
    const sheet = getBookingsSheet_(ss);
    const values = sheet.getDataRange().getValues();
    let row = -1;
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][0]) === String(b.id)) { row = i + 1; break; }
    }
    const nights = dateDiff_(b.checkIn, b.checkOut);
    const rooms = Array.isArray(b.rooms) && b.rooms.length ? b.rooms : [b.room || ''];
    const record = [
      String(b.id), safeCell_(b.resortName), rooms.join(', '), safeCell_(b.guestName), safeCell_(b.phone),
      safeCell_(b.guestType), b.checkIn || '', b.checkOut || '', nights,
      number_(b.nightlyRate), number_(b.discountAmount), number_(b.totalAmount),
      number_(b.paidAmount), number_(b.dueAmount), safeCell_(b.status), safeCell_(b.paymentNote),
      safeCell_(b.notes), payload.action, new Date()
    ];
    if (row === -1) {
      row = sheet.getLastRow() + 1;
      sheet.getRange(row, 1, 1, HEADERS.length).setValues([record]);
      appendLog_(payload.action.toUpperCase(), b.id, 'Booking row created/inserted.');
    } else {
      sheet.getRange(row, 1, 1, HEADERS.length).setValues([record]);
      appendLog_(payload.action.toUpperCase(), b.id, 'Booking row updated.');
    }
    sheet.getRange(row, 19).setNumberFormat('yyyy-mm-dd hh:mm:ss');
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold').setBackground('#176b5b').setFontColor('#ffffff');
    return json_({ ok: true, action: payload.action, bookingId: b.id, row: row });
  } catch (err) {
    try { appendLog_('ERROR', '', String(err && err.message ? err.message : err)); } catch (_) {}
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function doGet() {
  return json_({ ok: true, service: 'Resort Booking Manager Sheets Sync', message: 'Web App is deployed. Send POST requests from the booking app.' });
}

function getBookingsSheet_(ss) {
  let sheet = ss.getSheetByName(BOOKINGS_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(BOOKINGS_SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  } else {
    const current = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), HEADERS.length)).getValues()[0];
    if (String(current[0]) !== 'Booking ID') {
      throw new Error('The "' + BOOKINGS_SHEET_NAME + '" tab already exists but does not have the expected Booking ID header. Rename/remove that tab or make it blank, then retry.');
    }
    if (sheet.getLastColumn() < HEADERS.length) {
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    }
  }
  return sheet;
}

function appendLog_(action, bookingId, details) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) return;
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(['Timestamp', 'Action', 'Booking ID', 'Details']);
    sheet.setFrozenRows(1);
  }
  sheet.appendRow([new Date(), action, bookingId, details]);
}

function dateDiff_(start, end) {
  if (!start || !end) return '';
  const a = new Date(String(start) + 'T00:00:00Z');
  const b = new Date(String(end) + 'T00:00:00Z');
  const n = Math.round((b.getTime() - a.getTime()) / 86400000);
  return n >= 0 ? n : '';
}
function number_(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function safeCell_(v) {
  const s = String(v == null ? '' : v);
  // Prevent guest-entered text from being interpreted as a spreadsheet formula.
  return /^[=+@]/.test(s) || /^-[^0-9]/.test(s) ? "'" + s : s;
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
