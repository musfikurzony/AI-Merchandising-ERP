import { effectiveEtd } from "./deliveryDate.js";

/* ==========================================================================
   The ETD buffer — a private margin on the date the factory is told.
   ==========================================================================
   A merchandiser sets a number of days on a PO; the factory portal shows
   the delivery date MINUS that number, so the factory works to an earlier
   date than the real one and the slack stays in the merchandiser's hands.
   Zero by default — until somebody sets a buffer, the factory sees exactly
   what it saw before.

   --------------------------------------------------------------------------
   WHERE THE SUBTRACTION HAS TO HAPPEN, AND WHY IT IS NOT HERE
   --------------------------------------------------------------------------
   This file computes the buffered date for the MERCHANDISER'S OWN screens —
   the "Factory will see: 05 Nov" preview in Edit Order, and nothing else.

   It is NOT how the factory portal gets its date, and it must never become
   that. If the factory's browser received the true ETD and subtracted the
   buffer for display, the true date would still be sitting in the JSON
   response, one glance at the network tab away. Hiding a value in the UI is
   not hiding it.

   The real subtraction belongs in the `factory_portal_orders` VIEW, which is
   the actual security boundary for that portal (it is what excludes FOB and
   internal remarks today). Migration 39 adds the column and the SQL helper;
   the view change is the second half of it. Until that has run, this feature
   is stored but NOT ACTIVE, and `bufferState()` below is what the UI uses to
   say so rather than implying a protection that is not in place.

   --------------------------------------------------------------------------
   WHAT THE BUFFER MUST NEVER TOUCH
   --------------------------------------------------------------------------
   Every internal number — reports, KPIs, the notification engine, the sales
   matrix, on-time performance — reads `effectiveEtd()` and knows nothing
   about this file. A buffer is a negotiating position, not a fact about the
   order, and the day it starts moving a published figure the two halves of
   the company are reading different books.
*/

export const MAX_BUFFER_DAYS = 30;

/* 0 first and named, because it is the default and "no buffer" should read
   as a deliberate state rather than as an empty dropdown. */
export const BUFFER_CHOICES = [
  { days: 0, label: "No buffer" },
  ...Array.from({ length: MAX_BUFFER_DAYS }, (_, i) => ({ days: i + 1, label: `${i + 1} day${i === 0 ? "" : "s"} earlier` })),
];

export function bufferDays(order) {
  const n = Number(order?.etd_buffer_days);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(MAX_BUFFER_DAYS, Math.round(n));
}

export function hasBuffer(order) {
  return bufferDays(order) > 0;
}

/* The date the factory is intended to see: the latest committed delivery
   date, moved earlier by the buffer. Built on effectiveEtd() rather than on
   `etd`, so revising a PO moves the factory's date with it — a buffer
   applied to a stale original would quietly go out of date the first time
   anything slipped. */
export function factoryVisibleEtd(order) {
  const base = effectiveEtd(order);
  if (!base) return null;
  const n = bufferDays(order);
  if (n === 0) return base;
  return shiftDays(base, -n);
}

/* Same rule for a loose date plus a loose number — used by the preview in
   the edit form, where the user is typing a date that is not saved yet. */
export function applyBuffer(isoDate, days) {
  if (!isoDate) return null;
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) return isoDate;
  return shiftDays(isoDate, -Math.min(MAX_BUFFER_DAYS, Math.round(n)));
}

/* UTC arithmetic, the same reason milestoneReminder.js uses it: a
   merchandiser in Dhaka and a manager in Miami must compute the same day. */
function shiftDays(iso, delta) {
  const t = Date.parse(String(iso) + "T00:00:00Z");
  if (Number.isNaN(t)) return null;
  return new Date(t + delta * 86400000).toISOString().slice(0, 10);
}

export function describeBuffer(order) {
  const n = bufferDays(order);
  if (n === 0) return "No buffer — the factory sees the real delivery date.";
  return `${n} day${n === 1 ? "" : "s"} — the factory is shown a date ${n} day${n === 1 ? "" : "s"} earlier than the real one.`;
}

/* --------------------------------------------------------------------------
   Is the buffer actually in force?
   --------------------------------------------------------------------------
   Answered from the data, not from a config flag somebody has to remember to
   flip: if `etd_buffer_days` is not a column on the orders we loaded, the
   migration has not run, so nothing is stored and nothing is hidden. The UI
   uses this to tell the truth about its own state — a screen that shows
   "Factory will see: 05 Nov" while the factory is still being served 15 Nov
   is worse than no feature at all.
*/
export function bufferState(order) {
  if (!order || !("etd_buffer_days" in order)) return "unavailable";
  return "stored";
}
