import { supabase } from "./supabaseClient.js";
import { canViewFob, getOrderColorWaysForOrders } from "./ordersApi.js";
import { fetchAllPaged, fetchAllByIds, countRows, countByIds, reconcile, integrityOf } from "./supabaseFetch.js";

/* Reports Center data layer, Phase 1.

   The core design principle, stated explicitly because it's the easiest
   thing to get subtly wrong: ORDER-LEVEL data and SHIPMENT-LEVEL data are
   kept as two separate shapes, never flattened into one row set that a
   report might accidentally sum twice.

   - Order-level: one row per order (or per order+color for quantity
     questions). order.qty / a color way's qty is read exactly once per
     order/color, no matter how many shipment_lines that order has --
     shipped/balance/actual-ETD are AGGREGATED from shipment_lines first
     (summed per order), then joined onto the order-level row as a single
     value, exactly the same pattern already proven correct in
     kpiApi.js's fetchShipmentDataForOrders(). This is what "Open Orders,"
     "Factory Performance," "Total Business," etc. read from.

   - Shipment-level: one row per shipment_lines record, kept separately,
     used specifically for questions that are genuinely about individual
     shipments -- "which destination received the most quantity," "how
     many pieces shipped between two dates," "which colors have multiple
     partial shipments." A shipment carrying 3 order/color lines
     contributes 3 real rows here, which is correct -- each line is a
     distinct quantity of goods that actually moved, not a duplicate of
     the same fact.

   Never mix the two: a report answering an order-level question (open
   qty by factory) must aggregate the order-level shape; a report
   answering a shipment-level question (volume by destination) must
   aggregate the shipment-level shape. Mixing them is exactly how a
   multi-line shipment would get double-counted. */

const REPORT_ORDER_SELECT = `
  id, po_prefix, po_number, style, season, qty, etd, revised_etd, order_rcv_date,
  status, risk, factory_code, primary_merchandiser_id, fabric_ref, delivery_sequence, split_from_order_id,
  customer_code, product_group_code, label_code, division_code, business_unit_code,
  product_groups(code, name), product_categories(name), labels(code, name), divisions(code, name),
  business_units(code, name), customers(code, name), factories(code, name),
  profiles!orders_primary_merchandiser_id_fkey(id, full_name)
`;

const DATE_BASIS_COLUMN = { po_issue: "order_rcv_date", etd: "etd", revised_etd: "revised_etd" };
// actual_etd and crd are not direct order columns -- filtered in JS after
// the shipment/CRD data is loaded, since they live in joined tables.
const DATE_BASIS_NEEDS_POSTFILTER = ["actual_etd", "crd"];

/* The filter predicate lives in ONE function, applied to both the data
   query and the count query. If they were written twice they could drift,
   and a reconciliation check comparing two different questions is worse
   than no check at all. */
function applyOrderFilters(query, filters) {
  query = query.eq("is_deleted", false);
  if (filters.factoryCode) query = query.eq("factory_code", filters.factoryCode);
  if (filters.merchandiserId) query = query.eq("primary_merchandiser_id", filters.merchandiserId);
  if (filters.customerCode) query = query.eq("customer_code", filters.customerCode);
  if (filters.labelCode) query = query.eq("label_code", filters.labelCode);
  if (filters.divisionCode) query = query.eq("division_code", filters.divisionCode);
  if (filters.productGroupCode) query = query.eq("product_group_code", filters.productGroupCode);
  if (filters.businessUnitCode) query = query.eq("business_unit_code", filters.businessUnitCode);
  if (filters.season) query = query.eq("season", filters.season);
  if (filters.style) query = query.ilike("style", `%${filters.style}%`);
  if (filters.po) query = query.or(`po_prefix.ilike.%${filters.po}%,po_number.ilike.%${filters.po}%`);
  if (filters.status) query = query.eq("status", filters.status);
  else if (!filters.includeCancelled) query = query.neq("status", "cancelled");

  const basis = filters.dateBasis || "etd";
  if (!DATE_BASIS_NEEDS_POSTFILTER.includes(basis)) {
    const col = DATE_BASIS_COLUMN[basis] || "etd";
    if (filters.dateFrom) query = query.gte(col, filters.dateFrom);
    if (filters.dateTo) query = query.lte(col, filters.dateTo);
  }
  return query;
}

/* Paged, never truncated. The previous version issued one `.select()` and
   trusted the result — which silently stopped at PostgREST's row ceiling
   (1,000 by default) and produced confident, wrong numbers on any dataset
   larger than that. */
async function fetchReportOrders(filters) {
  const canFob = await canViewFob();
  const select = canFob ? `${REPORT_ORDER_SELECT}, fob` : REPORT_ORDER_SELECT;
  const rows = await fetchAllPaged((from, to) =>
    applyOrderFilters(supabase.from("orders").select(select), filters)
      .order("id", { ascending: true })      // a stable order — paging without one can repeat or skip rows
      .range(from, to));
  const { count, error } = await countRows("orders", q => applyOrderFilters(q, filters));
  return { rows, expected: count, countError: error };
}

/* Shipment lines for a set of orders, WITH the shipment header embedded --
   this is the shipment-level shape, kept as its own array (never merged
   into the order rows). */
const SHIPMENT_LINE_SELECT = "id, order_id, color_way_name, shipped_qty, unit_price, shipment_value, shipments(booking_date, vessel, actual_etd, actual_eta, destination_port, ship_mode, invoice_number, invoice_date, consignee_name)";

async function fetchReportShipmentLines(orderIds) {
  const rows = await fetchAllByIds("shipment_lines", SHIPMENT_LINE_SELECT, "order_id", orderIds, { order: "id" });
  const { count, error } = await countByIds("shipment_lines", "order_id", orderIds);
  return { rows, expected: count, countError: error };
}

async function fetchReportCrd(orderIds) {
  /* Every CRD row, not just the first page — the latest-per-order reduction
     below is only correct if the whole history arrived. Sorted ascending by
     id for stable paging, then reduced by created_at in JS. */
  const rows = await fetchAllByIds("crd_updates", "order_id, new_crd, previous_crd, created_at", "order_id", orderIds, { order: "id" });
  const { count, error } = await countByIds("crd_updates", "order_id", orderIds);
  const latest = new Map(), history = new Map();
  for (const row of rows) {
    if (!history.has(row.order_id)) history.set(row.order_id, []);
    history.get(row.order_id).push(row);
    const cur = latest.get(row.order_id);
    if (!cur || row.created_at > cur.created_at) latest.set(row.order_id, row);
  }
  const latestValue = new Map([...latest].map(([k, v]) => [k, v.new_crd]));
  return { rows, latest: latestValue, latestRow: latest, history, expected: count, countError: error };
}

async function fetchReportColorWays(orderIds) {
  const rows = await fetchAllByIds("order_color_ways", "order_id, name, qty", "order_id", orderIds, { order: "order_id" });
  const { count, error } = await countByIds("order_color_ways", "order_id", orderIds);
  const byOrder = new Map();
  for (const cw of rows) {
    if (!byOrder.has(cw.order_id)) byOrder.set(cw.order_id, []);
    byOrder.get(cw.order_id).push(cw);
  }
  return { byOrder, rows, expected: count, countError: error };
}

/* The one function every report reads from. Returns the two shapes
   described above, plus a per-order shipment SUMMARY (shipped qty summed
   across every line for that order, latest actual_etd across those
   lines, partial-shipment flag) -- the same aggregation-per-order
   pattern kpiApi.js already uses, reused here rather than reinvented. */
export async function buildReportDataset(filters = {}) {
  const ordersRes = await fetchReportOrders(filters);
  let orders = ordersRes.rows;
  const orderIds = orders.map(o => o.id);

  const [linesRes, crdRes, colorRes] = await Promise.all([
    fetchReportShipmentLines(orderIds),
    fetchReportCrd(orderIds),
    fetchReportColorWays(orderIds),
  ]);
  const shipmentLines = linesRes.rows;
  const crdByOrder = crdRes.latest;
  const colorWaysByOrder = colorRes.byOrder;

  /* Every dataset reconciled against an exact COUNT taken separately. A
     mismatch means rows exist that this browser did not receive — which
     the screen must say out loud, because a missing row and an absent fact
     look identical once they reach a rule. */
  const integrity = integrityOf([
    reconcile("Orders", orders.length, ordersRes.expected, ordersRes.countError),
    reconcile("Shipment lines", shipmentLines.length, linesRes.expected, linesRes.countError),
    reconcile("CRD updates", crdRes.rows.length, crdRes.expected, crdRes.countError),
    reconcile("Colour ways", colorRes.rows.length, colorRes.expected, colorRes.countError),
  ]);

  // Post-filter for date bases that live in joined data, not a direct
  // order column.
  const basis = filters.dateBasis || "etd";
  if (DATE_BASIS_NEEDS_POSTFILTER.includes(basis) && (filters.dateFrom || filters.dateTo)) {
    const relevantOrderIds = new Set();
    if (basis === "actual_etd") {
      for (const line of shipmentLines) {
        const d = line.shipments?.actual_etd;
        if (d && (!filters.dateFrom || d >= filters.dateFrom) && (!filters.dateTo || d <= filters.dateTo)) relevantOrderIds.add(line.order_id);
      }
    } else if (basis === "crd") {
      for (const [orderId, d] of crdByOrder) {
        if (d && (!filters.dateFrom || d >= filters.dateFrom) && (!filters.dateTo || d <= filters.dateTo)) relevantOrderIds.add(orderId);
      }
    }
    orders = orders.filter(o => relevantOrderIds.has(o.id));
  }

  // Per-order shipment summary -- shipped_qty SUMMED across every line
  // for that order (regardless of how many colors/partial shipments make
  // it up), latest actual_etd across those lines. This is the order-level
  // shape; a report grouping by factory/merchandiser/etc. reads this, not
  // the raw shipmentLines array, so a 3-line shipment never contributes 3x
  // to an order-level total.
  const shipmentSummaryByOrder = new Map();
  for (const line of shipmentLines) {
    const existing = shipmentSummaryByOrder.get(line.order_id) || { shippedQty: 0, latestActualEtd: null, lineCount: 0, destinations: new Set() };
    existing.shippedQty += line.shipped_qty;
    existing.lineCount += 1;
    const d = line.shipments?.actual_etd;
    if (d && (!existing.latestActualEtd || d > existing.latestActualEtd)) existing.latestActualEtd = d;
    if (line.shipments?.destination_port) existing.destinations.add(line.shipments.destination_port);
    shipmentSummaryByOrder.set(line.order_id, existing);
  }

  return {
    orders, shipmentLines, crdByOrder, colorWaysByOrder, shipmentSummaryByOrder,
    // CRD history is now carried too: "original vs revised CRD, days changed"
    // needs more than the latest value, and re-fetching it elsewhere would
    // be a second data path for the same fact.
    crdHistoryByOrder: crdRes.history, crdLatestRow: crdRes.latestRow,
    integrity,
  };
}

/* --- Report metric computations, Phase 2 --- all operate on the
   order-level shape (orders + shipmentSummaryByOrder), never the raw
   shipmentLines array, for the same no-double-counting reason explained
   above. */

export function orderMetrics(order, shipmentSummaryByOrder) {
  const summary = shipmentSummaryByOrder.get(order.id);
  const orderedQty = order.qty || 0;
  const shippedQty = summary?.shippedQty || 0;
  const balanceQty = orderedQty - shippedQty;
  const orderValue = "fob" in order && order.fob != null ? orderedQty * order.fob : null;
  const shippedValue = "fob" in order && order.fob != null ? shippedQty * order.fob : null;
  return { orderedQty, shippedQty, balanceQty, shipmentPct: orderedQty ? Math.round((shippedQty / orderedQty) * 100) : 0, orderValue, shippedValue, hasPartialShipments: (summary?.lineCount || 0) > 1 };
}

export function computeOpenOrders(orders, shipmentSummaryByOrder) {
  const open = orders.filter(o => o.status !== "shipped" && o.status !== "cancelled");
  const totals = open.reduce((acc, o) => { const m = orderMetrics(o, shipmentSummaryByOrder); acc.qty += m.orderedQty; acc.value += m.orderValue || 0; return acc; }, { qty: 0, value: 0 });
  return { rows: open, poCount: open.length, ...totals };
}

export function computeShippedOrders(orders, shipmentSummaryByOrder) {
  const shipped = orders.filter(o => o.status === "shipped");
  const totals = shipped.reduce((acc, o) => { const m = orderMetrics(o, shipmentSummaryByOrder); acc.qty += m.shippedQty; acc.value += m.shippedValue || 0; return acc; }, { qty: 0, value: 0 });
  return { rows: shipped, poCount: shipped.length, ...totals };
}

export function computeTotalBusiness(orders, shipmentSummaryByOrder) {
  const active = orders.filter(o => o.status !== "cancelled");
  const totals = active.reduce((acc, o) => { const m = orderMetrics(o, shipmentSummaryByOrder); acc.qty += m.orderedQty; acc.value += m.orderValue || 0; return acc; }, { qty: 0, value: 0 });
  return { rows: active, poCount: active.length, ...totals };
}

/* On-Time Shipment -- an order counts once, using its LATEST shipment
   line's actual_etd (an order isn't done shipping until its last partial
   shipment goes out), same rule already established in kpiApi.js. Only
   orders with at least one real shipment are in the denominator. */
export function computeOnTimeShipment(orders, shipmentSummaryByOrder) {
  let hit = 0, miss = 0;
  const missRows = [];
  for (const o of orders) {
    const summary = shipmentSummaryByOrder.get(o.id);
    if (!summary?.latestActualEtd || !o.etd) continue;
    if (summary.latestActualEtd <= o.etd) hit++;
    else { miss++; missRows.push(o); }
  }
  const denom = hit + miss;
  return { hit, miss, rate: denom ? Math.round((hit / denom) * 100) : null, missRows };
}

/* Corporate OTD analysis -- not just a single percentage, but how late
   the delayed ones actually were, bucketed exactly as specified (1-7
   days / 8-14 days / >14 days), plus average and maximum delay. Reuses
   the exact same "an order isn't done shipping until its last partial
   shipment goes out" rule computeOnTimeShipment already established --
   this is a richer view of the same underlying comparison, not a
   competing calculation. */
export function computeOTDAnalysis(orders, shipmentSummaryByOrder) {
  const rows = [];
  for (const o of orders) {
    const summary = shipmentSummaryByOrder.get(o.id);
    if (!summary?.latestActualEtd || !o.etd) continue;
    const delayDays = Math.round((new Date(summary.latestActualEtd) - new Date(o.etd)) / 86400000);
    rows.push({ order: o, delayDays, onTime: delayDays <= 0 });
  }
  const onTime = rows.filter(r => r.onTime);
  const delayed = rows.filter(r => !r.onTime);
  const buckets = {
    "1-7 days": delayed.filter(r => r.delayDays >= 1 && r.delayDays <= 7),
    "8-14 days": delayed.filter(r => r.delayDays >= 8 && r.delayDays <= 14),
    ">14 days": delayed.filter(r => r.delayDays > 14),
  };
  const delayValues = delayed.map(r => r.delayDays);
  return {
    totalPOs: rows.length,
    onTimeCount: onTime.length,
    delayedCount: delayed.length,
    otdPct: rows.length ? Math.round((onTime.length / rows.length) * 100) : null,
    avgDelayDays: delayValues.length ? Math.round((delayValues.reduce((a, b) => a + b, 0) / delayValues.length) * 10) / 10 : null,
    maxDelayDays: delayValues.length ? Math.max(...delayValues) : null,
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
    delayedRows: delayed,
  };
}

/* Short Shipment -- only orders with at least some real shipment activity
   are counted (an order that hasn't shipped at all isn't "short
   shipped," it's simply not shipped yet). */
export function computeShortShipment(orders, shipmentSummaryByOrder) {
  const withShipments = orders.filter(o => (shipmentSummaryByOrder.get(o.id)?.shippedQty || 0) > 0);
  const shortRows = withShipments.filter(o => {
    const m = orderMetrics(o, shipmentSummaryByOrder);
    return m.balanceQty > 0;
  });
  const fullyShippedRows = withShipments.filter(o => orderMetrics(o, shipmentSummaryByOrder).balanceQty <= 0);
  const pcts = withShipments.map(o => {
    const m = orderMetrics(o, shipmentSummaryByOrder);
    return m.orderedQty ? ((m.orderedQty - m.shippedQty) / m.orderedQty) * 100 : 0;
  });
  const avgShortPct = pcts.length ? Math.round((pcts.reduce((a, b) => a + b, 0) / pcts.length) * 10) / 10 : null;
  // Delivery-sequence breakdown -- how many of the orders in this filter
  // are a Delivery 1 vs a later delivery created by a split, reusing
  // the same delivery_sequence column Migration 35 introduced -- not a
  // second concept of "delivery."
  const byDeliverySeq = {};
  for (const o of orders) {
    const seq = o.delivery_sequence || 1;
    byDeliverySeq[seq] = (byDeliverySeq[seq] || 0) + 1;
  }
  return {
    shippedOrderCount: withShipments.length, shortCount: shortRows.length,
    fullyShippedCount: fullyShippedRows.length, partiallyShippedCount: shortRows.length,
    avgShortPct, shortRows, byDeliverySeq,
  };
}

export function computeLeadTime(orders) {
  const withDates = orders.filter(o => o.order_rcv_date && o.etd);
  const days = withDates.map(o => Math.round((new Date(o.etd) - new Date(o.order_rcv_date)) / 86400000));
  const avg = days.length ? Math.round(days.reduce((a, b) => a + b, 0) / days.length) : null;
  return { avgDays: avg, sampleCount: days.length, min: days.length ? Math.min(...days) : null, max: days.length ? Math.max(...days) : null };
}

/* Generic Group By + Top N -- the single mechanism every "Top 20 X by Y"
   question falls out of, rather than a separate hardcoded report per
   dimension. */
export const GROUP_DIMENSIONS = [
  ["factory", "Factory", o => o.factory_code, o => o.factories?.name || "Unassigned"],
  ["productGroup", "Product Group", o => o.product_group_code, o => o.product_groups?.name || "—"],
  ["merchandiser", "Merchandiser", o => o.primary_merchandiser_id, o => o.profiles?.full_name || "Unassigned"],
  ["customer", "Customer", o => o.customer_code, o => o.customers?.name || "—"],
  ["label", "Label", o => o.label_code, o => o.labels?.name || "—"],
  ["businessUnit", "Business Unit", o => o.business_unit_code, o => o.business_units?.name || "—"],
  ["season", "Season", o => o.season, o => o.season || "—"],
  ["style", "Style", o => o.style, o => o.style],
];

export function groupAndRank(orders, shipmentSummaryByOrder, dimensionKey, metricKey = "orderedQty", topN = null) {
  const dim = GROUP_DIMENSIONS.find(d => d[0] === dimensionKey) || GROUP_DIMENSIONS[0];
  const [, , keyFn, labelFn] = dim;
  const groups = new Map();
  for (const o of orders) {
    const key = keyFn(o);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, { key, label: labelFn(o), orders: [] });
    groups.get(key).orders.push(o);
  }
  let rows = [...groups.values()].map(g => {
    const totals = g.orders.reduce((acc, o) => {
      const m = orderMetrics(o, shipmentSummaryByOrder);
      acc.orderedQty += m.orderedQty; acc.shippedQty += m.shippedQty; acc.balanceQty += m.balanceQty;
      acc.orderValue += m.orderValue || 0; acc.poCount += 1;
      return acc;
    }, { orderedQty: 0, shippedQty: 0, balanceQty: 0, orderValue: 0, poCount: 0 });
    return { key: g.key, label: g.label, ...totals };
  });
  rows.sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0));
  if (topN) rows = rows.slice(0, topN);
  return rows;
}

/* Shipment-level: destinations and volume shipped in a date range --
   reads shipmentLines directly (the shipment-level shape), since this is
   genuinely a "how much moved through here" question, not an order-level
   one. */
export function groupShipmentsByDestination(shipmentLines, topN = null) {
  const groups = new Map();
  for (const line of shipmentLines) {
    const dest = line.shipments?.destination_port || "Unspecified";
    if (!groups.has(dest)) groups.set(dest, { destination: dest, qty: 0, lineCount: 0 });
    groups.get(dest).qty += line.shipped_qty;
    groups.get(dest).lineCount += 1;
  }
  let rows = [...groups.values()].sort((a, b) => b.qty - a.qty);
  if (topN) rows = rows.slice(0, topN);
  return rows;
}

export function shippedQtyInDateRange(shipmentLines, dateFrom, dateTo) {
  return shipmentLines.filter(l => {
    const d = l.shipments?.booking_date;
    return d && (!dateFrom || d >= dateFrom) && (!dateTo || d <= dateTo);
  }).reduce((s, l) => s + l.shipped_qty, 0);
}

/* Which colors have multiple partial shipments -- shipment-level
   question, grouped by order+color. */
export function stylesWithPartialShipments(shipmentLines) {
  const byOrderColor = new Map();
  for (const line of shipmentLines) {
    const key = `${line.order_id}|${line.color_way_name}`;
    byOrderColor.set(key, (byOrderColor.get(key) || 0) + 1);
  }
  return [...byOrderColor.entries()].filter(([, count]) => count > 1).map(([key, count]) => ({ key, shipmentCount: count }));
}

/* Shipping Invoice List -- reuses buildReportDataset() entirely for
   filtering (Factory/Product Group/Label/Customer/Status/PO/Style/Date
   range all come from the same shared function every other report
   already uses), then flattens the shipment-level shapeit already
   fetches into one row per real shipment line, joined back to its order
   for identity context. Invoice Number is the one filter that needs a
   post-fetch pass, since it lives on the shipment header, not the order. */
export async function buildShippingInvoiceRows(filters = {}) {
  const data = await buildReportDataset(filters);
  let lines = data.shipmentLines;
  if (filters.invoiceNumber) {
    const needle = filters.invoiceNumber.toLowerCase();
    lines = lines.filter(l => (l.shipments?.invoice_number || "").toLowerCase().includes(needle));
  }
  // Confirmed real bug found via live testing: "Ordered Qty" was reading
  // the order's TOTAL qty (o.qty) for every color line, so a 4-color PO
  // showed the same full PO total on all 4 rows instead of each color's
  // own ordered quantity -- meaning it could never be meaningfully
  // compared against that color's own shipped qty. Fixed by fetching
  // order_color_ways (the same bulk function the Excel export on Orders
  // already uses) and matching each row by its own order_id + color.
  const colorWaysByOrder = await getOrderColorWaysForOrders(lines.map(l => l.order_id));
  const rows = lines.map(l => {
    const o = data.orders.find(ord => ord.id === l.order_id);
    const colorWay = (colorWaysByOrder.get(l.order_id) || []).find(cw => cw.name === l.color_way_name);
    return {
      invoiceNumber: l.shipments?.invoice_number || "",
      invoiceDate: l.shipments?.invoice_date || "",
      factory: o?.factories?.name || "",
      po: o ? `${o.po_prefix}${o.po_number}` : "",
      style: o?.style || "",
      color: l.color_way_name || "",
      productGroup: o?.product_groups?.name || "",
      label: o?.labels?.name || "",
      customer: o?.customers?.name || "",
      orderedQty: colorWay?.qty ?? o?.qty ?? "",
      shippedQty: l.shipped_qty,
      unitPrice: l.unit_price,
      shipmentValue: l.shipment_value,
      bookingDate: l.shipments?.booking_date || "",
      actualEtd: l.shipments?.actual_etd || "",
      actualEta: l.shipments?.actual_eta || "",
      destinationPort: l.shipments?.destination_port || "",
      vessel: l.shipments?.vessel || "",
      consignee: l.shipments?.consignee_name || "",
      status: o?.status || "",
      deliverySequence: o?.delivery_sequence || 1,
    };
  });
  return { rows, orders: data.orders, shipmentSummaryByOrder: data.shipmentSummaryByOrder };
}

/* Fiscal year: February -> January, labeled by the calendar year in
   which it ends (January) -- confirmed against all four examples given
   (Feb-2026 delivery -> FY2027, Aug-2026 -> FY2027, Jan-2027 -> FY2027,
   Feb-2027 -> FY2028). The ONE canonical definition used everywhere a
   fiscal year is needed -- filters, growth reports, PDF labels -- so it
   can never drift into a second, competing definition. */
/* The start month is configurable from v86 (Organization Settings, migration
   37) rather than hardcoded, because a change of financial calendar should be
   a settings edit and not a code change. It is held in a module-level variable
   set once at sign-in: these two functions are called from filter bars, report
   headers, quarter derivation and period resolution, several of them inside
   render, so making them async would have rippled through the whole reporting
   layer for a value that changes at most once in the life of a company.

   The default is 2 (February), so with no configuration every fiscal year,
   range, quarter and label is byte-identical to what the ERP produced before
   this became configurable. */
const DEFAULT_FY_START_MONTH = 2;      // 1-12, February
let fyStartMonth = DEFAULT_FY_START_MONTH;

export function setFiscalYearStartMonth(month) {
  const m = Number(month);
  fyStartMonth = Number.isInteger(m) && m >= 1 && m <= 12 ? m : DEFAULT_FY_START_MONTH;
  return fyStartMonth;
}
export function getFiscalYearStartMonth() { return fyStartMonth; }

export function getFiscalYear(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const month = d.getMonth() + 1;      // 1-indexed to match the setting
  const year = d.getFullYear();
  return month >= fyStartMonth ? year + 1 : year;
}

export function getFiscalYearRange(fiscalYear) {
  const mm = String(fyStartMonth).padStart(2, "0");
  const startYear = fiscalYear - 1;
  /* The last day before the same month one year later — computed rather than
     assumed, so a January start (which ends on 31 December) and a March start
     (which ends on the last day of February, leap years included) are both
     right without a special case. */
  const endDate = new Date(Date.UTC(fiscalYear, fyStartMonth - 1, 1));
  endDate.setUTCDate(endDate.getUTCDate() - 1);
  return { start: `${startYear}-${mm}-01`, end: endDate.toISOString().slice(0, 10) };
}

export function fiscalYearLabel(fiscalYear) {
  return `FY${fiscalYear}`;
}

/* ==========================================================================
   On-Time Performance — delay-band analysis (the Shipment Control layout)
   ==========================================================================
   The prototype presents on-time performance as four mutually exclusive
   DELAY BANDS with their own PO count, share of POs, shipped quantity and
   shipped value, closed by a single grand-total line, plus the same four
   bands broken out per vendor/factory so it's visible where the delay is
   actually concentrated.

   This deliberately reuses computeOTDAnalysis()'s exact comparison rule --
   an order's LATEST actual ETD (an order isn't done shipping until its
   last partial shipment goes out) against its PO ETD -- rather than
   introducing a second definition of "late". The band edges are the same
   1-7 / 8-14 / >14 day boundaries that function already buckets by; they
   are simply labelled in the business's own words here ("up to 1 week",
   "1-2 weeks", "over 2 weeks"). An order with no actual ETD, or no PO
   ETD, is not counted in either direction -- it is reported separately as
   "not yet comparable" instead of being silently treated as on-time,
   which would flatter the number. */

/* The four band colours are a STATUS ramp (good → warning → serious →
   critical), not four arbitrary categories, and they were validated
   rather than eyeballed: run through a colour-vision/contrast checker,
   every adjacent pair now clears both the colour-blind separation floor
   and the normal-vision floor, with each step inside the usable lightness
   band. The amber sits below 3:1 against white — accepted deliberately,
   because every place it appears carries a written label and a number
   beside it (donut legend, table row, PDF, Excel), so the colour never
   has to carry the meaning alone. */
export const DELAY_BANDS = [
  ["ontime", "On-time",            "var(--band-ontime)", "#2E9E7B"],
  ["w1",     "Delayed ≤ 1 week",   "var(--band-w1)",     "#DDA83F"],
  ["w2",     "Delayed 1–2 weeks",  "var(--band-w2)",     "#D2552A"],
  ["late",   "Delayed > 2 weeks",  "var(--band-late)",   "#8E2E1E"],
];

/* Two-series planned-vs-actual. The planned series is deliberately a
   near-neutral slate: it is a REFERENCE, not a peer category, and it
   should recede behind what actually shipped. The pair still clears the
   colour-vision separation floor, and identity is additionally carried by
   the legend and the tooltip, never by hue alone. */
export const SERIES_PLANNED = "#8B98AC";
export const SERIES_ACTUAL = "#3F72AF";

export function delayBandOf(delayDays) {
  if (delayDays <= 0) return "ontime";
  if (delayDays <= 7) return "w1";
  if (delayDays <= 14) return "w2";
  return "late";
}

export function computeOnTimeBands(orders, shipmentSummaryByOrder, dimensionKey = "factory") {
  const compared = [];
  let notComparable = 0;

  for (const o of orders) {
    const summary = shipmentSummaryByOrder.get(o.id);
    if (!summary?.latestActualEtd || !o.etd) { notComparable++; continue; }
    const delayDays = Math.round((new Date(summary.latestActualEtd) - new Date(o.etd)) / 86400000);
    const m = orderMetrics(o, shipmentSummaryByOrder);
    compared.push({
      order: o, delayDays, band: delayBandOf(delayDays),
      shipQty: m.shippedQty, shipValue: m.shippedValue || 0,
    });
  }

  const totalPOs = compared.length;
  const bands = DELAY_BANDS.map(([key, label, cssVar, hex]) => {
    const rows = compared.filter(r => r.band === key);
    return {
      key, label, cssVar, hex,
      poCount: rows.length,
      pctOfPos: totalPOs ? (rows.length / totalPOs) * 100 : 0,
      shipQty: rows.reduce((s, r) => s + r.shipQty, 0),
      shipValue: rows.reduce((s, r) => s + r.shipValue, 0),
      rows,
    };
  });

  const totals = {
    poCount: totalPOs,
    pctOfPos: totalPOs ? 100 : 0,
    shipQty: bands.reduce((s, b) => s + b.shipQty, 0),
    shipValue: bands.reduce((s, b) => s + b.shipValue, 0),
  };

  // Per-vendor breakdown, using the SAME GROUP_DIMENSIONS mechanism every
  // other grouped report reads from -- so "by vendor/factory" is one
  // selected dimension, not a hardcoded vendor-only report. Sorted worst
  // on-time % first: this table exists to show where the problem is.
  const dim = GROUP_DIMENSIONS.find(d => d[0] === dimensionKey) || GROUP_DIMENSIONS[0];
  const [, dimLabel, keyFn, labelFn] = dim;
  const groups = new Map();
  for (const r of compared) {
    const key = keyFn(r.order) ?? "—";
    if (!groups.has(key)) groups.set(key, { key, label: labelFn(r.order), ontime: 0, w1: 0, w2: 0, late: 0, total: 0, shipQty: 0, shipValue: 0, worstDelay: 0 });
    const g = groups.get(key);
    g[r.band] += 1;
    g.total += 1;
    g.shipQty += r.shipQty;
    g.shipValue += r.shipValue;
    if (r.delayDays > g.worstDelay) g.worstDelay = r.delayDays;
  }
  const byVendor = [...groups.values()]
    .map(g => ({ ...g, onTimePct: g.total ? Math.round((g.ontime / g.total) * 100) : 0 }))
    .sort((a, b) => a.onTimePct - b.onTimePct || b.total - a.total);

  return { bands, totals, byVendor, dimensionLabel: dimLabel, comparedCount: totalPOs, notComparable, compared };
}

/* The delayed-PO detail behind the bands -- what a merchandiser actually
   chases. Kept separate from the summary so the summary stays cheap. */
export function delayedOrderRows(bandResult) {
  return bandResult.compared
    .filter(r => r.band !== "ontime")
    .sort((a, b) => b.delayDays - a.delayDays);
}

/* ==========================================================================
   Round 2 additions — two-level grouping, business summary, monthly trend
   ==========================================================================
   All three operate on the SAME order-level shape (orders +
   shipmentSummaryByOrder) that every existing report reads, except
   monthlyShipmentSeries()'s shipped half, which is genuinely
   shipment-level and says so. Nothing here re-derives a metric that
   orderMetrics() already defines. */

export function groupDimension(key) {
  return GROUP_DIMENSIONS.find(d => d[0] === key) || GROUP_DIMENSIONS[0];
}
export function groupDimensionLabel(key) {
  return groupDimension(key)[1];
}

function emptyTotals() {
  return { poCount: 0, styleCount: 0, orderedQty: 0, shippedQty: 0, balanceQty: 0, orderValue: 0, shippedValue: 0 };
}
function addOrder(acc, o, shipmentSummaryByOrder, styleSet) {
  const m = orderMetrics(o, shipmentSummaryByOrder);
  acc.poCount += 1;
  acc.orderedQty += m.orderedQty;
  acc.shippedQty += m.shippedQty;
  acc.balanceQty += m.balanceQty;
  acc.orderValue += m.orderValue || 0;
  acc.shippedValue += m.shippedValue || 0;
  if (styleSet && o.style) styleSet.add(o.style);
  return acc;
}

/* Two-level grouping: "by Factory, then by Product Group". Returns parent
   rows each carrying their own children, so one report answers both the
   summary question and the drill-down behind it — rather than needing a
   second report, or a filter round-trip, to see what makes up a number.
   Passing a null second dimension gives exactly the same shape with no
   children, so callers don't need two code paths. */
export function groupTwoLevel(orders, shipmentSummaryByOrder, dimKey, dim2Key = null, metricKey = "orderedQty", topN = null) {
  const [, , keyFn, labelFn] = groupDimension(dimKey);
  const dim2 = dim2Key ? groupDimension(dim2Key) : null;

  const groups = new Map();
  for (const o of orders) {
    const key = keyFn(o) ?? "—";
    if (!groups.has(key)) groups.set(key, { key, label: labelFn(o), orders: [], styles: new Set(), totals: emptyTotals() });
    const g = groups.get(key);
    g.orders.push(o);
    addOrder(g.totals, o, shipmentSummaryByOrder, g.styles);
  }

  let rows = [...groups.values()].map(g => {
    let children = [];
    if (dim2) {
      const [, , k2, l2] = dim2;
      const sub = new Map();
      for (const o of g.orders) {
        const key2 = k2(o) ?? "—";
        if (!sub.has(key2)) sub.set(key2, { key: `${g.key}|${key2}`, label: l2(o), styles: new Set(), totals: emptyTotals() });
        const s = sub.get(key2);
        addOrder(s.totals, o, shipmentSummaryByOrder, s.styles);
      }
      children = [...sub.values()]
        .map(s => ({ key: s.key, label: s.label, ...s.totals, styleCount: s.styles.size }))
        .sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0));
    }
    return { key: g.key, label: g.label, ...g.totals, styleCount: g.styles.size, children };
  });

  rows.sort((a, b) => (b[metricKey] || 0) - (a[metricKey] || 0));
  const truncated = topN && rows.length > topN;
  const hiddenCount = truncated ? rows.length - topN : 0;
  // The grand total is deliberately computed over EVERY group, not just
  // the visible top N -- otherwise "Total" silently means "total of the
  // ten rows I chose to show you", which is how a report misleads.
  const grandTotal = rows.reduce((acc, r) => {
    acc.poCount += r.poCount; acc.styleCount += r.styleCount;
    acc.orderedQty += r.orderedQty; acc.shippedQty += r.shippedQty;
    acc.balanceQty += r.balanceQty; acc.orderValue += r.orderValue; acc.shippedValue += r.shippedValue;
    return acc;
  }, emptyTotals());
  if (truncated) rows = rows.slice(0, topN);

  const visibleTotal = rows.reduce((acc, r) => {
    acc.poCount += r.poCount; acc.styleCount += r.styleCount;
    acc.orderedQty += r.orderedQty; acc.shippedQty += r.shippedQty;
    acc.balanceQty += r.balanceQty; acc.orderValue += r.orderValue; acc.shippedValue += r.shippedValue;
    return acc;
  }, emptyTotals());

  return { rows, grandTotal, visibleTotal, truncated, hiddenCount, dimensionLabel: groupDimensionLabel(dimKey), dimension2Label: dim2Key ? groupDimensionLabel(dim2Key) : null };
}

/* The headline business picture — one object the Executive Dashboard and
   any "Total Business" style report both read, so the top-line number is
   the same figure on both screens. */
export function computeBusinessSummary(orders, shipmentSummaryByOrder) {
  const active = orders.filter(o => o.status !== "cancelled");
  const styles = new Set(), factories = new Set(), customers = new Set(), pos = new Set();
  const totals = emptyTotals();
  for (const o of active) {
    addOrder(totals, o, shipmentSummaryByOrder, styles);
    if (o.factory_code) factories.add(o.factory_code);
    if (o.customer_code) customers.add(o.customer_code);
    pos.add(`${o.po_prefix}${o.po_number}`);
  }
  const open = active.filter(o => o.status !== "shipped");
  const shipped = active.filter(o => o.status === "shipped");
  const openTotals = open.reduce((a, o) => addOrder(a, o, shipmentSummaryByOrder), emptyTotals());
  const shippedTotals = shipped.reduce((a, o) => addOrder(a, o, shipmentSummaryByOrder), emptyTotals());
  const cancelled = orders.filter(o => o.status === "cancelled");

  return {
    ...totals,
    styleCount: styles.size, poCount: pos.size, orderLineCount: active.length,
    factoryCount: factories.size, customerCount: customers.size,
    open: { count: open.length, qty: openTotals.orderedQty, value: openTotals.orderValue, balanceQty: openTotals.balanceQty },
    shipped: { count: shipped.length, qty: shippedTotals.shippedQty, value: shippedTotals.shippedValue },
    cancelledCount: cancelled.length,
    shipmentPct: totals.orderedQty ? Math.round((totals.shippedQty / totals.orderedQty) * 100) : 0,
  };
}

/* Monthly trend across a period. Ordered quantity is placed in the month
   of the order's ETD (order-level, counted once); shipped quantity comes
   from the shipment lines themselves, placed in the month each shipment
   actually left (shipment-level). They are deliberately sourced
   differently because they are genuinely different questions -- "what was
   due this month" vs "what actually moved this month" -- and forcing both
   onto one basis is what makes a trend chart quietly wrong. */
export function monthlyShipmentSeries(orders, shipmentLines, shipmentSummaryByOrder, dateFrom, dateTo) {
  const months = new Map();
  const keyOf = iso => String(iso).slice(0, 7);
  const ensure = k => {
    if (!months.has(k)) months.set(k, { month: k, orderedQty: 0, orderValue: 0, shippedQty: 0, shippedValue: 0, poCount: 0 });
    return months.get(k);
  };

  // Seed every month in the range so a month with zero activity is a real
  // zero on the chart, not a missing point the line jumps over.
  if (dateFrom && dateTo) {
    const cur = new Date(dateFrom + "T00:00:00");
    const end = new Date(dateTo + "T00:00:00");
    let guard = 0;
    while (cur <= end && guard++ < 120) {
      ensure(`${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}`);
      cur.setMonth(cur.getMonth() + 1);
    }
  }

  for (const o of orders) {
    if (o.status === "cancelled" || !o.etd) continue;
    const m = ensure(keyOf(o.etd));
    const met = orderMetrics(o, shipmentSummaryByOrder);
    m.orderedQty += met.orderedQty;
    m.orderValue += met.orderValue || 0;
    m.poCount += 1;
  }
  for (const line of shipmentLines) {
    const d = line.shipments?.actual_etd || line.shipments?.booking_date;
    if (!d) continue;
    const m = ensure(keyOf(d));
    m.shippedQty += line.shipped_qty || 0;
    m.shippedValue += Number(line.shipment_value) || 0;
  }

  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(m => {
      const [y, mm] = m.month.split("-");
      return { ...m, label: `${MON[Number(mm) - 1]} ${y.slice(2)}` };
    });
}

/* Distinct seasons present in the loaded data — the season filter's
   options come from what actually exists, since there is no seasons
   master table to read from and inventing one would be a schema change
   nobody asked for. */
export function seasonsIn(orders) {
  return [...new Set(orders.map(o => o.season).filter(Boolean))].sort();
}

/* Orders needing attention — the same rule the Executive Dashboard's
   "needs attention" panel and (next round) the AI notifications both read,
   so the dashboard and the alerts can never disagree about what is late. */
export function attentionList(orders, shipmentSummaryByOrder, today = new Date().toISOString().slice(0, 10)) {
  const out = [];
  for (const o of orders) {
    if (o.status === "cancelled" || o.status === "shipped") continue;
    const m = orderMetrics(o, shipmentSummaryByOrder);
    const etd = o.revised_etd || o.etd;
    if (!etd) {
      out.push({ order: o, severity: "warn", reason: "No ETD set", daysPastEtd: null, ...m });
      continue;
    }
    const daysPastEtd = Math.round((new Date(today) - new Date(etd)) / 86400000);
    if (daysPastEtd > 0 && m.shippedQty <= 0) {
      out.push({ order: o, severity: "critical", reason: `ETD passed ${daysPastEtd}d ago, nothing shipped`, daysPastEtd, ...m });
    } else if (daysPastEtd > 0 && m.balanceQty > 0) {
      out.push({ order: o, severity: "critical", reason: `ETD passed ${daysPastEtd}d ago, ${m.balanceQty.toLocaleString()} pcs still open`, daysPastEtd, ...m });
    } else if (daysPastEtd > -14 && daysPastEtd <= 0 && m.shippedQty <= 0) {
      out.push({ order: o, severity: "warn", reason: `Ships within ${Math.abs(daysPastEtd)}d, nothing shipped yet`, daysPastEtd, ...m });
    } else if (o.risk === "critical") {
      out.push({ order: o, severity: "warn", reason: "Flagged critical risk", daysPastEtd, ...m });
    }
  }
  const rank = { critical: 0, warn: 1 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.daysPastEtd ?? -999) - (a.daysPastEtd ?? -999));
}
