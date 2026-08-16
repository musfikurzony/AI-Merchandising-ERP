/* Real, ISO-date-aware port of v13's fmtCompact() -- same selectable
   formats (DD/MM/YY default, MM/DD/YY, DD-Mon-YYYY), adapted for real
   Postgres date strings ("2026-11-18") instead of v13's demo
   "05-Dec-2026" strings. The format itself is chosen in ErpShell's header
   and passed down via React Router's Outlet context (useOutletContext()),
   not a parallel context provider -- one mechanism, not two.

   Two no-year formats (MMDD / DDMM) added on request, specifically for
   narrow columns like the Workbench's frozen ETD/Rev ETD -- day and month
   are what's needed for a quick glance there; the year is still shown in
   full everywhere a date matters more precisely (Order Detail, Edit Order,
   the Working Sheet). */

export function fmtCompact(isoDate, format) {
  if (!isoDate) return "—";
  const m = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return isoDate;
  const [, yr4, mon, day] = m;
  const yr = yr4.slice(2);
  const fmt = format || "DDMMYY";
  if (fmt === "MMDD") return `${mon}/${day}`;
  if (fmt === "DDMM") return `${day}/${mon}`;
  if (fmt === "MMDDYY") return `${mon}/${day}/${yr}`;
  if (fmt === "DDMMMYYYY") {
    const MONTHS_3_REV = { "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr", "05": "May", "06": "Jun", "07": "Jul", "08": "Aug", "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec" };
    return `${day}-${MONTHS_3_REV[mon]}-${yr4}`;
  }
  return `${day}/${mon}/${yr}`;
}

export const DATE_FORMAT_OPTIONS = [
  ["DDMMYY", "DD/MM/YY (BD office)"],
  ["MMDDYY", "MM/DD/YY (US)"],
  ["DDMMMYYYY", "DD-Mon-YYYY"],
  ["DDMM", "DD/MM (no year, compact)"],
  ["MMDD", "MM/DD (no year, compact)"],
];
