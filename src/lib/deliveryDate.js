/* ==========================================================================
   The delivery date. One definition, for the whole ERP.
   ==========================================================================
   An order can carry two dates: `etd`, the date agreed when the PO was
   booked, and `revised_etd`, the date it was later moved to. Before this
   file, 24 places in the application read `o.etd` directly and each one
   decided for itself whether the revision mattered. It usually did not, so
   a PO booked for November and revised into December kept counting in
   November — the quantity sat in a month it was never going to ship in.

   The rule the business actually works to:

       effectiveEtd(order) = revised_etd || etd

   which is to say: **the latest committed delivery date**. Every screen that
   answers "when is this shipping" or "how much is in this month" reads that
   and nothing else.

   ------------------------------------------------------------------------
   WHAT THIS DELIBERATELY DOES NOT DO
   ------------------------------------------------------------------------
   It does not touch on-time performance, lead time, or the days-late
   figures. Those measure against `etd` — the ORIGINAL commitment — on
   purpose, and the reason matters enough to write down:

     A revised ETD *is* the slip. Measuring delivery against a date you
     moved to accommodate the slip scores every late order on time. OTD
     would read 100% forever and the report would be worthless.

   So the two questions are kept apart, the same way plan/actual and status
   are kept apart in `milestoneReminder.js`:

     effectiveEtd  "when will this ship, and which month does it count in?"
     order.etd     "what did we promise, and did we keep it?"

   If that trade-off is ever revisited it is a business decision, not a
   refactor — the call sites that intentionally use the original are marked
   `// ORIGINAL ETD: on purpose` so they can be found in one grep.
*/

export function effectiveEtd(order) {
  if (!order) return null;
  return order.revised_etd || order.etd || null;
}

/* The same rule for callers holding two loose values rather than an order
   row — the AI Assistant's flattened notification rows, for instance, carry
   `etd` and `revisedEtd` in camelCase and are not order objects. */
export function effectiveEtdOf(etd, revisedEtd) {
  return revisedEtd || etd || null;
}

/* True when the date actually moved. `revised_etd` set to the same day as
   `etd` is not a revision, and treating it as one would put a "revised"
   marker on orders nobody touched. */
export function isEtdRevised(order) {
  const r = order?.revised_etd;
  return !!r && r !== order?.etd;
}

export function etdSlipDays(order) {
  if (!isEtdRevised(order)) return 0;
  return Math.round((Date.parse(order.revised_etd + "T00:00:00Z") - Date.parse(order.etd + "T00:00:00Z")) / 86400000);
}

/* "YYYY-MM" for the month an order's quantity belongs to. Every monthly
   bucket in the application goes through this, so a bucket can never be
   built on the original date by accident — there is no second place to
   write `String(o.etd).slice(0, 7)`. */
export function etdMonthKey(order) {
  const d = effectiveEtd(order);
  return d ? String(d).slice(0, 7) : null;
}

/* Sorting by delivery date. Nulls sort last rather than first: an order
   with no ETD is not the most urgent thing on the page, it is the least
   scheduled, and putting it at the top of every list buries real work. */
export function byEffectiveEtd(a, b) {
  const x = effectiveEtd(a), y = effectiveEtd(b);
  if (!x && !y) return 0;
  if (!x) return 1;
  if (!y) return -1;
  return x.localeCompare(y);
}

/* Range predicate for the ETD From / ETD To filters. A merchandiser who
   filters "November" means "what ships in November", so an order booked for
   October and revised into November has to appear — which is the whole
   point of the change. */
export function etdInRange(order, from, to) {
  const d = effectiveEtd(order);
  if (!d) return !from && !to;      // undated orders only survive an unfiltered view
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}
