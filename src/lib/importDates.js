/* ==========================================================================
   A date from a spreadsheet, or an honest refusal.
   ==========================================================================
   `new Date("11/10/2026")` is 10 November. In this office that cell means 11
   October. The importer used to call exactly that and take whatever came
   back, so a Licensee PO could be booked a month out with nothing on any
   screen to show for it — and the error would only surface when a factory
   asked why the date moved.

   So: parse what can be parsed WITHOUT guessing, and refuse the rest with a
   message naming the formats that work. A rejected row is a nuisance; a
   silently wrong delivery date is a shipment.

   --------------------------------------------------------------------------
   WHAT IS ACCEPTED, AND WHY EACH ONE IS SAFE
   --------------------------------------------------------------------------
   - A real Excel date cell. Excel stores it as a serial number with no
     format ambiguity; the reader is asked for Date objects (cellDates) so
     these arrive already unambiguous. This is what the guide recommends.
   - YYYY-MM-DD. Year first. Nothing else looks like it.
   - DD-MMM-YYYY / DD MMM YY. The month is spelled, so it cannot be read as
     a day.
   - MMM DD, YYYY. Same reason.

   REFUSED:
   - Anything of the form a/b/c or a.b.c where both a and b are 12 or less.
     That is precisely the ambiguous case, and precisely the common one.
   - a/b/c where one part is clearly a day (13-31) IS accepted, because there
     is then only one reading — 25/12/2026 can only be 25 December. Refusing
     it would reject perfectly clear data and push people towards retyping,
     which introduces its own errors.
*/

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y, m, d) {
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const yr = y < 100 ? (y >= 70 ? 1900 + y : 2000 + y) : y;
  /* Built as a string rather than through Date, because `new Date(y, m, d)`
     applies the browser's timezone and can shift the day by one either side
     of midnight — which is how a delivery date lands on the wrong day for
     half the office. */
  const s = `${String(yr).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  /* Reject impossible days (31 February) by round-tripping through UTC,
     which has no timezone to shift it. */
  const check = new Date(`${s}T00:00:00Z`);
  if (isNaN(check) || check.getUTCDate() !== d || check.getUTCMonth() + 1 !== m) return null;
  return s;
}

export const AMBIGUOUS = "AMBIGUOUS";

/* Returns an ISO date string, null for an empty cell, or the AMBIGUOUS
   sentinel for a value that has more than one reasonable reading. The
   caller turns that sentinel into a row error naming the accepted formats —
   done there rather than here so the message lives with the field guide. */
export function parseImportDate(v) {
  if (v === null || v === undefined || v === "") return null;

  /* A real Excel date cell, already unambiguous. Read in UTC: the reader
     constructs these at local midnight, and toISOString() on a local
     midnight east of Greenwich rolls back to the previous day. */
  if (v instanceof Date) {
    if (isNaN(v)) return null;
    return iso(v.getFullYear(), v.getMonth() + 1, v.getDate());
  }

  /* An Excel serial number — 1900-based, with Excel's deliberate leap-year
     bug already accounted for by the 25569 offset. */
  if (typeof v === "number" && Number.isFinite(v)) {
    if (v <= 0) return null;
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d) ? null : iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  const s = String(v).trim().replace(/\s+/g, " ");
  if (!s) return null;

  /* A serial number that arrived as text, which happens when a sheet is
     read without cellDates. */
  if (/^\d{5}(\.\d+)?$/.test(s)) return parseImportDate(Number(s));

  /* YYYY-MM-DD, with / or . tolerated as the separator. Year first is never
     ambiguous. */
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return iso(+m[1], +m[2], +m[3]);

  /* A spelled month, in either order: 11-Oct-2026, 11 Oct 26, Oct 11 2026. */
  m = s.match(/^(\d{1,2})[-\s/](\p{L}{3,9})\.?[-\s/](\d{2,4})$/u);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase().slice(0, 4)] ?? MONTHS[m[2].toLowerCase().slice(0, 3)];
    return mo ? iso(+m[3], mo, +m[1]) : null;
  }
  m = s.match(/^(\p{L}{3,9})\.?[-\s/](\d{1,2}),?[-\s/](\d{2,4})$/u);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase().slice(0, 4)] ?? MONTHS[m[1].toLowerCase().slice(0, 3)];
    return mo ? iso(+m[3], mo, +m[2]) : null;
  }

  /* All-numeric with the year last. This is where the ambiguity lives. */
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    /* One of them is over 12, so only one reading is possible. */
    if (a > 12 && b <= 12) return iso(y, b, a);     // 25/12/2026 -> 25 December
    if (b > 12 && a <= 12) return iso(y, a, b);     // 12/25/2026 -> 25 December
    if (a > 12 && b > 12) return null;              // neither is a month
    return AMBIGUOUS;                                // 11/10/2026 — refuse
  }

  /* Anything else. Deliberately NOT handed to `new Date()` as a last resort:
     that is what produced the wrong answers in the first place, and a parser
     whose fallback is a guess is a guessing parser. */
  return null;
}

/* The message a rejected row carries. Built from the field guide so the
   error, the on-screen help and the template can never say different things. */
export function dateErrorFor(header, raw, ambiguous) {
  if (ambiguous) {
    return `${header}: "${raw}" could be read two ways (day/month or month/day). ` +
      `Write it as 2026-10-11 or 11-Oct-2026, or format the column as a Date in Excel.`;
  }
  return `${header}: "${raw}" is not a date this import understands. ` +
    `Use 2026-10-11 or 11-Oct-2026, or format the column as a Date in Excel.`;
}

export const __internals = { iso, MONTHS };
