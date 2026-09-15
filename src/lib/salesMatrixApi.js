import { orderMetrics, GROUP_DIMENSIONS, groupDimensionLabel, getFiscalYear, getFiscalYearRange, getFiscalYearStartMonth } from "./reportsApi.js";
import { effectiveEtd } from "./deliveryDate.js";

/* ==========================================================================
   The fiscal-year sales matrix.
   ==========================================================================
   The report a corporate office actually circulates: twelve fiscal months
   across the page, the business down the side, and a cumulative line under
   the total so you can answer "how much had we booked by August?" without
   adding up eight columns by hand — with the same figure for last year
   beside it.

   This file adds NO new business rules. Every quantity and value comes from
   `orderMetrics()`, the rows are grouped by the same `GROUP_DIMENSIONS`
   every other report uses, the months come from `getFiscalYearRange()`, and
   the month an order falls into comes from `effectiveEtd()`. If Reports
   Center says a factory shipped 412,000 pcs this year, so does this.

   --------------------------------------------------------------------------
   THE ONE THING WORTH READING BEFORE CHANGING ANYTHING HERE
   --------------------------------------------------------------------------
   "Open + Shipped" must not count an order twice, and the way it avoids
   that is by SPLITTING THE ORDERS, not by summing two reports:

     - a shipped order contributes its SHIPPED quantity, in the month it
       actually shipped;
     - an open order contributes its ORDERED quantity, in the month it is
       expected to ship (its latest committed ETD);
     - cancelled orders contribute nothing.

   Those three sets are disjoint by construction — an order has exactly one
   status — so the combined view is a partition of the book, not an overlay
   of two. That is the same split `computeOpenOrders()` and
   `computeShippedOrders()` already make, deliberately, so the three scopes
   here and those two reports can never disagree.
*/

export const SALES_SCOPES = [
  ["open", "Open Orders", "Booked and still to ship, in the month they are expected to ship"],
  ["shipped", "Shipped", "Actually shipped, in the month it went out"],
  ["both", "Open + Shipped", "The whole book — shipped where it shipped, open where it is due"],
];

export const SALES_MEASURES = [
  ["qty", "Quantity", "pcs"],
  ["value", "Value", "USD"],
  ["both", "Quantity + Value", ""],
];

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* The twelve months of a fiscal year, in fiscal order — so a February start
   produces Feb…Jan and a January start produces Jan…Dec, from the same code.
   Derived from getFiscalYearRange() rather than from a hardcoded [1..12],
   because the start month is configurable (v86) and a second assumption
   about it here is exactly how the two would drift apart. */
export function fiscalMonths(fiscalYear) {
  const { start } = getFiscalYearRange(fiscalYear);
  const [y0, m0] = start.split("-").map(Number);
  const out = [];
  for (let i = 0; i < 12; i++) {
    const m = ((m0 - 1 + i) % 12) + 1;
    const y = y0 + Math.floor((m0 - 1 + i) / 12);
    out.push({
      key: `${y}-${String(m).padStart(2, "0")}`,
      label: `${MON[m - 1]}-${String(y).slice(2)}`,
      short: MON[m - 1],
      index: i,
    });
  }
  return out;
}

/* Where one order lands, and with what.

   Returns null for an order that contributes nothing to this scope, so the
   caller never has to repeat the status rules. */
export function contributionOf(order, shipmentSummaryByOrder, scope) {
  if (!order || order.status === "cancelled") return null;
  const m = orderMetrics(order, shipmentSummaryByOrder);
  const isShipped = order.status === "shipped";

  if (isShipped) {
    if (scope === "open") return null;
    const summary = shipmentSummaryByOrder.get(order.id);
    /* The month it actually shipped. An order marked shipped with no
       shipment line recorded falls back to its delivery date — it is better
       to place it in its expected month and have the total reconcile than
       to silently drop it out of the year. */
    const date = summary?.latestActualEtd || effectiveEtd(order);
    if (!date) return null;
    return { monthKey: String(date).slice(0, 7), qty: m.shippedQty, value: m.shippedValue || 0, basis: "shipped" };
  }

  if (scope === "shipped") return null;
  const date = effectiveEtd(order);
  if (!date) return null;
  return { monthKey: String(date).slice(0, 7), qty: m.orderedQty, value: m.orderValue || 0, basis: "open" };
}

function emptyCells(months) {
  return months.map(() => ({ qty: 0, value: 0, poCount: 0 }));
}

function addTo(cell, c) {
  cell.qty += c.qty || 0;
  cell.value += c.value || 0;
  cell.poCount += 1;
}

function runningTotal(cells) {
  let q = 0, v = 0, p = 0;
  return cells.map(c => { q += c.qty; v += c.value; p += c.poCount; return { qty: q, value: v, poCount: p }; });
}

/* --------------------------------------------------------------------------
   The matrix.
   --------------------------------------------------------------------------
   `orders` may span TWO fiscal years — the selected one and the one before
   it — because the comparison line needs last year's figures and loading
   the same dataset twice would double the query cost for data already in
   memory. Anything outside both years is ignored rather than silently
   folded into the nearest month.
*/
export function buildSalesMatrix({ orders = [], shipmentSummaryByOrder = new Map() }, {
  fiscalYear,
  dimension = "factory",
  scope = "both",
  topN = null,
} = {}) {
  const months = fiscalMonths(fiscalYear);
  const lastMonths = fiscalMonths(fiscalYear - 1);
  const monthIndex = new Map(months.map(m => [m.key, m.index]));
  const lastIndex = new Map(lastMonths.map(m => [m.key, m.index]));

  const dim = GROUP_DIMENSIONS.find(d => d[0] === dimension) || GROUP_DIMENSIONS[0];
  const [, , keyFn, labelFn] = dim;

  const groups = new Map();
  const total = emptyCells(months);
  const lastYear = emptyCells(lastMonths);

  let valuedOrders = 0, countedOrders = 0, skippedNoDate = 0, skippedOutOfRange = 0;

  for (const o of orders) {
    const c = contributionOf(o, shipmentSummaryByOrder, scope);
    if (!c) { if (o.status !== "cancelled" && !effectiveEtd(o)) skippedNoDate++; continue; }

    const i = monthIndex.get(c.monthKey);
    if (i === undefined) {
      const j = lastIndex.get(c.monthKey);
      if (j !== undefined) addTo(lastYear[j], c);
      else skippedOutOfRange++;
      continue;
    }

    countedOrders++;
    if (c.value > 0) valuedOrders++;

    const gk = keyFn(o) ?? "__none__";
    if (!groups.has(gk)) groups.set(gk, { key: gk, label: labelFn(o), cells: emptyCells(months), total: { qty: 0, value: 0, poCount: 0 } });
    const g = groups.get(gk);
    addTo(g.cells[i], c);
    g.total.qty += c.qty; g.total.value += c.value; g.total.poCount += 1;
    addTo(total[i], c);
  }

  let rows = [...groups.values()].sort((a, b) => b.total.qty - a.total.qty || a.label.localeCompare(b.label));
  let hidden = null;
  if (topN && rows.length > topN) {
    const rest = rows.slice(topN);
    const other = { key: "__other__", label: `Other (${rest.length} more)`, cells: emptyCells(months), total: { qty: 0, value: 0, poCount: 0 } };
    for (const r of rest) {
      r.cells.forEach((c, i) => { other.cells[i].qty += c.qty; other.cells[i].value += c.value; other.cells[i].poCount += c.poCount; });
      other.total.qty += r.total.qty; other.total.value += r.total.value; other.total.poCount += r.total.poCount;
    }
    hidden = rest.length;
    rows = [...rows.slice(0, topN), other];
  }

  const cumulative = runningTotal(total);
  const lastCumulative = runningTotal(lastYear);

  /* Variance is computed on the CUMULATIVE pair, because that is the
     question the line is there to answer: "are we ahead of where we were
     this time last year?" Month-on-month variance swings wildly on a single
     late shipment and tells a manager nothing. A month with no business last
     year yields null rather than a fabricated percentage — dividing by zero
     to print "+100%" is how a report loses its credibility. */
  const variance = cumulative.map((c, i) => ({
    qty: pctChange(c.qty, lastCumulative[i].qty),
    value: pctChange(c.value, lastCumulative[i].value),
  }));

  const grand = {
    qty: total.reduce((a, c) => a + c.qty, 0),
    value: total.reduce((a, c) => a + c.value, 0),
    poCount: total.reduce((a, c) => a + c.poCount, 0),
  };
  const lastGrand = {
    qty: lastYear.reduce((a, c) => a + c.qty, 0),
    value: lastYear.reduce((a, c) => a + c.value, 0),
    poCount: lastYear.reduce((a, c) => a + c.poCount, 0),
  };

  return {
    fiscalYear, months, lastMonths, scope, dimension,
    dimensionLabel: groupDimensionLabel(dimension),
    rows, hidden,
    total, cumulative, lastYear, lastCumulative, variance,
    grand, lastGrand,
    /* Honesty about the value columns. When FOB is hidden from this user,
       orderMetrics returns a null value and every value cell is 0 — which
       reads as "we sold nothing", not "you cannot see this". The screen uses
       this flag to say which it is. */
    hasValue: valuedOrders > 0,
    counted: countedOrders,
    skippedNoDate,
    skippedOutOfRange,
  };
}

export function pctChange(now, before) {
  if (!before) return null;                 // no base -> no percentage, ever
  return Math.round(((now - before) / before) * 1000) / 10;
}

/* --------------------------------------------------------------------------
   The date window the matrix needs loading.
   --------------------------------------------------------------------------
   Two fiscal years in ONE range, so the comparison line costs no extra
   query. The caller passes this straight into the existing report filters.
*/
export function matrixDateRange(fiscalYear) {
  const prior = getFiscalYearRange(fiscalYear - 1);
  const current = getFiscalYearRange(fiscalYear);
  return { dateFrom: prior.start, dateTo: current.end };
}

export function fiscalYearLabelFor(fiscalYear) {
  const { start, end } = getFiscalYearRange(fiscalYear);
  const s = new Date(start + "T00:00:00Z"), e = new Date(end + "T00:00:00Z");
  return `FY${fiscalYear} (${MON[s.getUTCMonth()]} ${s.getUTCFullYear()} – ${MON[e.getUTCMonth()]} ${e.getUTCFullYear()})`;
}

export function currentFiscalYear() {
  return getFiscalYear(new Date().toISOString().slice(0, 10));
}

export function fiscalStartMonthName() {
  return MON[getFiscalYearStartMonth() - 1];
}

/* --------------------------------------------------------------------------
   Export shaping — one function, so the on-screen table, the Excel sheet and
   the PDF are the same numbers formatted three ways rather than three
   assemblies that can drift.
   -------------------------------------------------------------------------- */
export function matrixToSheet(matrix, measure = "qty") {
  const { months, rows, dimensionLabel } = matrix;
  const wantQty = measure === "qty" || measure === "both";
  const wantValue = (measure === "value" || measure === "both") && matrix.hasValue;

  const colsFor = m => [
    ...(wantQty ? [[`${m.label} Qty`, c => c.qty]] : []),
    ...(wantValue ? [[`${m.label} Value`, c => round2(c.value)]] : []),
  ];

  const line = (label, cells, totalCell) => {
    const r = { [dimensionLabel]: label };
    months.forEach((m, i) => { for (const [h, f] of colsFor(m)) r[h] = f(cells[i]); });
    if (wantQty) r["Total Qty"] = totalCell ? totalCell.qty : cells.reduce((a, c) => a + c.qty, 0);
    if (wantValue) r["Total Value"] = round2(totalCell ? totalCell.value : cells.reduce((a, c) => a + c.value, 0));
    return r;
  };

  const body = rows.map(r => line(r.label, r.cells, r.total));

  /* The closing block, in the order a finance reader expects to meet it:
     what happened each month, what that adds up to as the year runs, the
     same for last year, and whether we are ahead. */
  const footer = [
    line(`TOTAL — ${scopeLabel(matrix.scope)}`, matrix.total, matrix.grand),
    line("CUMULATIVE (year to date)", matrix.cumulative, lastOf(matrix.cumulative)),
    line(`LAST YEAR (FY${matrix.fiscalYear - 1})`, matrix.lastYear, matrix.lastGrand),
    line("LAST YEAR CUMULATIVE", matrix.lastCumulative, lastOf(matrix.lastCumulative)),
  ];

  const varRow = { [dimensionLabel]: "VARIANCE vs LAST YEAR (cumulative %)" };
  months.forEach((m, i) => {
    if (wantQty) varRow[`${m.label} Qty`] = fmtPct(matrix.variance[i].qty);
    if (wantValue) varRow[`${m.label} Value`] = fmtPct(matrix.variance[i].value);
  });
  if (wantQty) varRow["Total Qty"] = fmtPct(pctChange(matrix.grand.qty, matrix.lastGrand.qty));
  if (wantValue) varRow["Total Value"] = fmtPct(pctChange(matrix.grand.value, matrix.lastGrand.value));
  footer.push(varRow);

  return { rows: [...body, ...footer], bodyCount: body.length, footerCount: footer.length };
}

function lastOf(cells) { return cells[cells.length - 1] || { qty: 0, value: 0, poCount: 0 }; }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
export function fmtPct(p) { return p == null ? "—" : `${p > 0 ? "+" : ""}${p}%`; }
export function scopeLabel(scope) { return (SALES_SCOPES.find(s => s[0] === scope) || SALES_SCOPES[2])[1]; }
