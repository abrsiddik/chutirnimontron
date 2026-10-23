/**
 * Chutir Nimontron Resort Booking Manager → Google Sheets
 *
 * Bound to your spreadsheet (Extensions → Apps Script).
 * Creates / maintains: All Bookings, Daily Report, Monthly Report, Dashboard, Sync Log.
 * Upserts by Booking ID (no duplicates). Rebuilds reports after every booking change
 * and on a scheduled daily trigger.
 *
 * 1. Replace SHARED_SECRET with a long random string (same value as in the app Settings).
 * 2. Deploy → New deployment → Web app → Execute as: Me → Anyone.
 * 3. Run installScheduledRefresh once from the Apps Script editor to create the daily trigger.
 */
const SHARED_SECRET = 'REPLACE_WITH_A_LONG_RANDOM_SECRET';
const ROOM_COUNT = 16;
const ALL_BOOKINGS_SHEET = 'All Bookings';
const LEGACY_BOOKINGS_SHEET = 'Booking Sync';
const DAILY_SHEET = 'Daily Report';
const MONTHLY_SHEET = 'Monthly Report';
const DASHBOARD_SHEET = 'Dashboard';
const LOG_SHEET_NAME = 'Sync Log';

const BOOKING_HEADERS = [
  'Booking ID', 'Resort', 'Room(s)', 'Guest Name', 'Phone', 'Booking Type',
  'Check-in', 'Check-out', 'Nights', 'Rate / Room / Night', 'Discount',
  'Total Amount', 'Received', 'Due', 'Status', 'Payment Note', 'Notes',
  'Last Action', 'Last Updated'
];

const DAILY_HEADERS = [
  'Date', 'Bookings', 'Check-ins', 'Check-outs', 'Occupied Rooms',
  'Revenue', 'Payments Received', 'Outstanding Dues', 'Occupancy %', 'Last Rebuilt'
];

const MONTHLY_HEADERS = [
  'Month', 'Total Bookings', 'Booking Revenue', 'Payments Received',
  'Outstanding Dues', 'Occupancy Rate %', 'Cancellations', 'Room-nights Sold',
  'Available Room-nights', 'Last Rebuilt'
];

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    const raw = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    const payload = JSON.parse(raw);
    if (!SHARED_SECRET || SHARED_SECRET === 'REPLACE_WITH_A_LONG_RANDOM_SECRET' || payload.secret !== SHARED_SECRET) {
      throw new Error('Unauthorized: shared secret does not match.');
    }

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) throw new Error('No spreadsheet is bound to this script. Open Apps Script from the spreadsheet.');

    lock.waitLock(30000);

    if (payload.action === 'test') {
      ensureAllSheets_(ss);
      appendLog_(ss, 'TEST', '', 'Connection test · reports sheets ready');
      rebuildReports_(ss);
      return json_({ ok: true, message: 'Test received · sheets ready · reports rebuilt' });
    }

    if (payload.action === 'refresh_reports') {
      ensureAllSheets_(ss);
      const summary = rebuildReports_(ss);
      appendLog_(ss, 'REFRESH', '', 'Reports rebuilt on demand');
      return json_({ ok: true, action: 'refresh_reports', summary: summary });
    }

    if (payload.action === 'sync_all') {
      const list = Array.isArray(payload.bookings) ? payload.bookings : [];
      ensureAllSheets_(ss);
      const sheet = getAllBookingsSheet_(ss);
      const upserted = upsertManyBookings_(sheet, list, 'sync_all');
      const summary = rebuildReports_(ss);
      appendLog_(ss, 'SYNC_ALL', '', 'Upserted ' + upserted + ' booking(s) · reports rebuilt');
      return json_({ ok: true, action: 'sync_all', upserted: upserted, summary: summary });
    }

    const allowed = ['create', 'edit', 'reschedule', 'cancel', 'payment'];
    if (allowed.indexOf(payload.action) === -1) throw new Error('Unsupported action: ' + payload.action);
    const b = payload.booking || {};
    if (!b.id) throw new Error('Booking ID is required.');

    ensureAllSheets_(ss);
    const sheet = getAllBookingsSheet_(ss);
    const row = upsertBookingRow_(sheet, b, payload.action);
    const summary = rebuildReports_(ss);
    appendLog_(ss, String(payload.action).toUpperCase(), b.id, 'Row ' + row + ' · reports rebuilt');
    return json_({ ok: true, action: payload.action, bookingId: b.id, row: row, summary: summary });
  } catch (err) {
    try { appendLog_(SpreadsheetApp.getActiveSpreadsheet(), 'ERROR', '', String(err && err.message ? err.message : err)); } catch (_) {}
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function doGet() {
  return json_({
    ok: true,
    service: 'Chutir Nimontron Resort Booking Manager Sheets Sync',
    sheets: [ALL_BOOKINGS_SHEET, DAILY_SHEET, MONTHLY_SHEET, DASHBOARD_SHEET, LOG_SHEET_NAME],
    message: 'Web App is deployed. POST booking events from the booking app.'
  });
}

/** Run once from the Apps Script editor after deploy to schedule a daily rebuild. */
function installScheduledRefresh() {
  const handlers = ScriptApp.getProjectTriggers().filter(function (t) {
    return t.getHandlerFunction() === 'scheduledReportRefresh';
  });
  handlers.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('scheduledReportRefresh').timeBased().everyDays(1).atHour(1).create();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) {
    ensureAllSheets_(ss);
    rebuildReports_(ss);
    appendLog_(ss, 'TRIGGER', '', 'Daily report refresh installed (≈01:00 script timezone)');
  }
  return 'Scheduled daily report refresh installed.';
}

/** Time-driven entry point — refreshes Daily / Monthly / Dashboard from All Bookings. */
function scheduledReportRefresh() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) return;
  ensureAllSheets_(ss);
  rebuildReports_(ss);
  appendLog_(ss, 'SCHEDULED', '', 'Daily scheduled report refresh completed');
}

/** Optional: run manually from the editor to rebuild without the website. */
function rebuildReportsNow() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureAllSheets_(ss);
  const summary = rebuildReports_(ss);
  appendLog_(ss, 'MANUAL', '', 'Manual rebuild');
  return summary;
}

function ensureAllSheets_(ss) {
  getAllBookingsSheet_(ss);
  getOrCreateSheet_(ss, DAILY_SHEET, DAILY_HEADERS);
  getOrCreateSheet_(ss, MONTHLY_SHEET, MONTHLY_HEADERS);
  getOrCreateSheet_(ss, DASHBOARD_SHEET, ['Section', 'Metric', 'Value', 'Notes']);
  getOrCreateSheet_(ss, LOG_SHEET_NAME, ['Timestamp', 'Action', 'Booking ID', 'Details']);
}

function getAllBookingsSheet_(ss) {
  let sheet = ss.getSheetByName(ALL_BOOKINGS_SHEET);
  const legacy = ss.getSheetByName(LEGACY_BOOKINGS_SHEET);
  if (!sheet && legacy) {
    legacy.setName(ALL_BOOKINGS_SHEET);
    sheet = legacy;
  }
  if (!sheet) sheet = ss.insertSheet(ALL_BOOKINGS_SHEET);
  ensureHeaderRow_(sheet, BOOKING_HEADERS);
  if (sheet.getLastRow() === 0 || String(sheet.getRange(1, 1).getValue()) !== 'Booking ID') {
    throw new Error('The "' + ALL_BOOKINGS_SHEET + '" tab is missing the Booking ID header. Clear or rename it, then retry.');
  }
  return sheet;
}

function getOrCreateSheet_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  ensureHeaderRow_(sheet, headers);
  return sheet;
}

function ensureHeaderRow_(sheet, headers) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    styleHeader_(sheet, headers.length);
    return;
  }
  const width = Math.max(sheet.getLastColumn(), headers.length);
  const current = sheet.getRange(1, 1, 1, width).getValues()[0];
  if (String(current[0]) !== String(headers[0]) || sheet.getLastColumn() < headers.length) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    styleHeader_(sheet, headers.length);
  }
}

function styleHeader_(sheet, cols) {
  sheet.getRange(1, 1, 1, cols).setFontWeight('bold').setBackground('#176b5b').setFontColor('#ffffff');
}

function upsertBookingRow_(sheet, b, action) {
  const values = sheet.getDataRange().getValues();
  let row = -1;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(b.id)) { row = i + 1; break; }
  }
  const record = bookingRecord_(b, action);
  if (row === -1) {
    row = Math.max(sheet.getLastRow(), 1) + 1;
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, BOOKING_HEADERS.length).setValues([BOOKING_HEADERS]);
      styleHeader_(sheet, BOOKING_HEADERS.length);
      row = 2;
    }
  }
  sheet.getRange(row, 1, 1, BOOKING_HEADERS.length).setValues([record]);
  sheet.getRange(row, 19).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  return row;
}

function upsertManyBookings_(sheet, list, action) {
  let count = 0;
  list.forEach(function (b) {
    if (!b || !b.id) return;
    upsertBookingRow_(sheet, b, action);
    count++;
  });
  return count;
}

function bookingRecord_(b, action) {
  const nights = dateDiff_(b.checkIn, b.checkOut);
  const rooms = Array.isArray(b.rooms) && b.rooms.length ? b.rooms : [b.room || ''];
  return [
    String(b.id),
    safeCell_(b.resortName),
    rooms.join(', '),
    safeCell_(b.guestName),
    safeCell_(b.phone),
    safeCell_(b.guestType),
    normalizeDate_(b.checkIn),
    normalizeDate_(b.checkOut),
    nights,
    number_(b.nightlyRate),
    number_(b.discountAmount),
    number_(b.totalAmount),
    number_(b.paidAmount),
    number_(b.dueAmount != null ? b.dueAmount : number_(b.totalAmount) - number_(b.paidAmount)),
    safeCell_(b.status || 'Booked'),
    safeCell_(b.paymentNote),
    safeCell_(b.notes),
    action || 'edit',
    new Date()
  ];
}

function readBookingsFromSheet_(sheet) {
  const values = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row[0]) continue;
    const checkIn = normalizeDate_(row[6]);
    const checkOut = normalizeDate_(row[7]);
    const rooms = String(row[2] || '')
      .split(/[,|]/)
      .map(function (s) { return s.replace(/Room\s*/i, '').trim(); })
      .filter(Boolean)
      .map(function (s) { return Number(s); })
      .filter(function (n) { return Number.isFinite(n) && n > 0; });
    out.push({
      id: String(row[0]),
      rooms: rooms.length ? rooms : [1],
      guestName: String(row[3] || ''),
      checkIn: checkIn,
      checkOut: checkOut,
      nights: number_(row[8]) || dateDiff_(checkIn, checkOut) || 1,
      totalAmount: number_(row[11]),
      paidAmount: number_(row[12]),
      dueAmount: number_(row[13]),
      status: String(row[14] || 'Booked')
    });
  }
  return out;
}

function rebuildReports_(ss) {
  const bookings = readBookingsFromSheet_(getAllBookingsSheet_(ss));
  const daily = buildDailyRows_(bookings);
  const monthly = buildMonthlyRows_(bookings);
  writeSheetRows_(getOrCreateSheet_(ss, DAILY_SHEET, DAILY_HEADERS), DAILY_HEADERS, daily);
  writeSheetRows_(getOrCreateSheet_(ss, MONTHLY_SHEET, MONTHLY_HEADERS), MONTHLY_HEADERS, monthly);
  writeDashboard_(ss, bookings, daily, monthly);
  return {
    bookings: bookings.length,
    dailyRows: daily.length,
    monthlyRows: monthly.length,
    rebuiltAt: new Date().toISOString()
  };
}

function buildDailyRows_(bookings) {
  const map = {};
  const rebuilt = new Date();
  bookings.forEach(function (b) {
    if (!b.checkIn || !b.checkOut) return;
    const cancelled = String(b.status).toLowerCase() === 'cancelled';
    const nights = Math.max(1, number_(b.nights) || dateDiff_(b.checkIn, b.checkOut) || 1);
    const revenuePerNight = number_(b.totalAmount) / nights;
    const paidPerNight = number_(b.paidAmount) / nights;

    ensureDay_(map, b.checkIn);
    if (!cancelled) {
      map[b.checkIn].bookings += 1;
      map[b.checkIn].checkIns += 1;
    }

    ensureDay_(map, b.checkOut);
    if (!cancelled) map[b.checkOut].checkOuts += 1;

    if (cancelled) return;

    eachStayNight_(b.checkIn, b.checkOut, function (date) {
      ensureDay_(map, date);
      map[date].occupiedRooms += b.rooms.length;
      map[date].revenue += revenuePerNight;
      map[date].payments += paidPerNight;
      map[date].dues += number_(b.dueAmount);
    });
  });

  return Object.keys(map).sort().map(function (date) {
    const d = map[date];
    const occPct = Math.round((d.occupiedRooms / ROOM_COUNT) * 1000) / 10;
    return [
      date,
      d.bookings,
      d.checkIns,
      d.checkOuts,
      d.occupiedRooms,
      round2_(d.revenue),
      round2_(d.payments),
      round2_(d.dues),
      occPct,
      rebuilt
    ];
  });
}

function buildMonthlyRows_(bookings) {
  const map = {};
  const rebuilt = new Date();
  bookings.forEach(function (b) {
    if (!b.checkIn || !b.checkOut) return;
    const cancelled = String(b.status).toLowerCase() === 'cancelled';
    const startMonth = b.checkIn.slice(0, 7);
    ensureMonth_(map, startMonth);
    if (cancelled) {
      map[startMonth].cancellations += 1;
      return;
    }
    map[startMonth].bookings += 1;

    const nights = Math.max(1, number_(b.nights) || dateDiff_(b.checkIn, b.checkOut) || 1);
    const revenuePerNight = number_(b.totalAmount) / nights;
    const paidPerNight = number_(b.paidAmount) / nights;

    eachStayNight_(b.checkIn, b.checkOut, function (date) {
      const month = date.slice(0, 7);
      ensureMonth_(map, month);
      map[month].roomNights += b.rooms.length;
      map[month].revenue += revenuePerNight;
      map[month].payments += paidPerNight;
    });

    // Outstanding dues attributed to the check-in month for active reservations.
    map[startMonth].dues += number_(b.dueAmount);
  });

  return Object.keys(map).sort().map(function (month) {
    const m = map[month];
    const days = daysInMonth_(month);
    const available = ROOM_COUNT * days;
    const occ = available ? Math.round((m.roomNights / available) * 1000) / 10 : 0;
    return [
      month,
      m.bookings,
      round2_(m.revenue),
      round2_(m.payments),
      round2_(m.dues),
      occ,
      m.cancellations,
      m.roomNights,
      available,
      rebuilt
    ];
  });
}

function writeDashboard_(ss, bookings, dailyRows, monthlyRows) {
  const sheet = getOrCreateSheet_(ss, DASHBOARD_SHEET, ['Section', 'Metric', 'Value', 'Notes']);
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Asia/Dhaka', 'yyyy-MM-dd');
  const thisMonth = today.slice(0, 7);
  const day = findRowByKey_(dailyRows, 0, today) || blankDaily_(today);
  const month = findRowByKey_(monthlyRows, 0, thisMonth) || blankMonthly_(thisMonth);

  const activeToday = bookings.filter(function (b) {
    return String(b.status).toLowerCase() !== 'cancelled' && b.checkIn <= today && today < b.checkOut;
  });
  const upcomingIns = bookings.filter(function (b) {
    return String(b.status).toLowerCase() !== 'cancelled' && b.checkIn >= today;
  }).length;
  const overdue = bookings.filter(function (b) {
    return String(b.status).toLowerCase() !== 'cancelled' &&
      String(b.status).toLowerCase() !== 'checked-out' &&
      b.checkOut < today;
  }).length;

  const rows = [
    ['Overview', 'Last refreshed', new Date(), 'Auto-updated on each booking sync and daily schedule'],
    ['Overview', 'Total booking records', bookings.length, 'Includes cancelled history rows'],
    ['Overview', 'Active stays today', activeToday.length, 'check-in ≤ today < check-out'],
    ['Today', 'Date', today, ''],
    ['Today', 'Bookings (check-ins scheduled)', day[1], 'Non-cancelled check-ins on this date'],
    ['Today', 'Check-ins', day[2], ''],
    ['Today', 'Check-outs', day[3], ''],
    ['Today', 'Occupied rooms', day[4], 'Out of ' + ROOM_COUNT],
    ['Today', 'Revenue (allocated)', day[5], 'Stay total spread across nights'],
    ['Today', 'Payments received (allocated)', day[6], 'Paid amount spread across nights'],
    ['Today', 'Outstanding dues (in-house)', day[7], 'Sum of dues for rooms occupied tonight'],
    ['Today', 'Occupancy %', day[8], ''],
    ['Today', 'Upcoming check-ins (from today)', upcomingIns, ''],
    ['Today', 'Overdue check-outs', overdue, 'Past check-out, not Checked-out / Cancelled'],
    ['This month', 'Month', thisMonth, ''],
    ['This month', 'Total bookings', month[1], 'Non-cancelled with check-in in this month'],
    ['This month', 'Booking revenue', month[2], 'Night-allocated across this month'],
    ['This month', 'Payments received', month[3], 'Night-allocated across this month'],
    ['This month', 'Outstanding dues', month[4], 'Dues for bookings checking in this month'],
    ['This month', 'Occupancy rate %', month[5], 'Room-nights sold ÷ (16 × days in month)'],
    ['This month', 'Cancellations', month[6], 'Cancelled bookings with check-in in this month'],
    ['This month', 'Room-nights sold', month[7], ''],
    ['Definitions', 'Revenue / payments', 'Allocated per stay night', 'Payment calendar dates are not stored in the app'],
    ['Definitions', 'Check-in / check-out', 'Inclusive / exclusive', 'Matches the booking manager calendar']
  ];

  sheet.clearContents();
  sheet.getRange(1, 1, 1, 4).setValues([['Section', 'Metric', 'Value', 'Notes']]);
  styleHeader_(sheet, 4);
  sheet.getRange(2, 1, rows.length, 4).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, 4);
}

function writeSheetRows_(sheet, headers, rows) {
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  styleHeader_(sheet, headers.length);
  sheet.setFrozenRows(1);
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    const lastCol = headers.length;
    sheet.getRange(2, lastCol, rows.length, 1).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  }
  sheet.autoResizeColumns(1, Math.min(headers.length, 10));
}

function ensureDay_(map, date) {
  if (!date) return;
  if (!map[date]) {
    map[date] = { bookings: 0, checkIns: 0, checkOuts: 0, occupiedRooms: 0, revenue: 0, payments: 0, dues: 0 };
  }
}

function ensureMonth_(map, month) {
  if (!month) return;
  if (!map[month]) {
    map[month] = { bookings: 0, revenue: 0, payments: 0, dues: 0, cancellations: 0, roomNights: 0 };
  }
}

function eachStayNight_(checkIn, checkOut, fn) {
  const start = parseYmd_(checkIn);
  const end = parseYmd_(checkOut);
  if (!start || !end || end <= start) return;
  for (let t = start.getTime(); t < end.getTime(); t += 86400000) {
    fn(formatYmd_(new Date(t)));
  }
}

function findRowByKey_(rows, idx, key) {
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][idx]) === String(key)) return rows[i];
  }
  return null;
}

function blankDaily_(date) {
  return [date, 0, 0, 0, 0, 0, 0, 0, 0, new Date()];
}

function blankMonthly_(month) {
  const days = daysInMonth_(month);
  return [month, 0, 0, 0, 0, 0, 0, 0, ROOM_COUNT * days, new Date()];
}

function daysInMonth_(ym) {
  const parts = String(ym).split('-');
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  if (!y || !m) return 30;
  return new Date(y, m, 0).getDate();
}

function normalizeDate_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'UTC', 'yyyy-MM-dd');
  }
  const s = String(v == null ? '' : v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return s;
}

function parseYmd_(s) {
  const n = normalizeDate_(s);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(n)) return null;
  const p = n.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
}

function formatYmd_(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function dateDiff_(start, end) {
  const a = parseYmd_(start);
  const b = parseYmd_(end);
  if (!a || !b) return '';
  const n = Math.round((b.getTime() - a.getTime()) / 86400000);
  return n >= 0 ? n : '';
}

function number_(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2_(n) {
  return Math.round(number_(n) * 100) / 100;
}

function safeCell_(v) {
  const s = String(v == null ? '' : v);
  return /^[=+@]/.test(s) || /^-[^0-9]/.test(s) ? "'" + s : s;
}

function appendLog_(ss, action, bookingId, details) {
  if (!ss) return;
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(['Timestamp', 'Action', 'Booking ID', 'Details']);
    sheet.setFrozenRows(1);
    styleHeader_(sheet, 4);
  }
  sheet.appendRow([new Date(), action, bookingId || '', details || '']);
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
