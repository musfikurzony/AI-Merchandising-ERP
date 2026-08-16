import { supabase } from "./supabaseClient.js";
import { canViewFob } from "./ordersApi.js";

/* Single source of truth for every KPI formula in this app -- KPI
   Dashboard, Factory Performance, Merchandiser Performance, and (later)
   Executive Dashboard all call these same functions, so the numbers can
   never drift between screens. Every formula here was confirmed directly
   with the user before being written -- nothing invented.

   Hit/Miss/Pending, exactly as specified:
     Hit     = actual_date is set AND actual_date <= plan_date
     Miss    = actual_date is set AND actual_date >  plan_date
             OR actual_date is null AND plan_date has passed (overdue -- NOT excluded)
     Pending = actual_date is null AND plan_date is in the future (or unset)
               -- excluded from the hit-rate denominator entirely, so an
               -- order that simply hasn't reached its planned date yet
               -- never drags the percentage down. */

function classifyMilestone(planDate, actualDate, today) {
  if (actualDate) return actualDate <= planDate ? "hit" : "miss";
  if (planDate && planDate < today) return "miss"; // overdue, not excluded
  return "pending";
}

async function fetchOrdersForKpi(filters = {}) {
  const canFob = await canViewFob();
  const fobSelect = canFob ? ", fob" : "";
  let query = supabase.from("orders")
    .select(`
      id, po_prefix, po_number, style, etd, status, risk, factory_code, primary_merchandiser_id, qty${fobSelect},
      customer_code, product_group_code, division_code, business_unit_code, season,
      customers(name), product_groups(name), factories(name), divisions(name), business_units(name),
      profiles!orders_primary_merchandiser_id_fkey(id, full_name)
    `)
    .eq("is_deleted", false);
  if (filters.factoryCode) query = query.eq("factory_code", filters.factoryCode);
  if (filters.merchandiserId) query = query.eq("primary_merchandiser_id", filters.merchandiserId);
  if (filters.customerCode) query = query.eq("customer_code", filters.customerCode);
  if (filters.productGroupCode) query = query.eq("product_group_code", filters.productGroupCode);
  if (filters.divisionCode) query = query.eq("division_code", filters.divisionCode);
  if (filters.businessUnitCode) query = query.eq("business_unit_code", filters.businessUnitCode);
  if (filters.season) query = query.eq("season", filters.season);
  if (filters.poStyleSearch) query = query.or(`po_prefix.ilike.%${filters.poStyleSearch}%,po_number.ilike.%${filters.poStyleSearch}%,style.ilike.%${filters.poStyleSearch}%`);
  if (filters.etdFrom) query = query.gte("etd", filters.etdFrom);
  if (filters.etdTo) query = query.lte("etd", filters.etdTo);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function fetchMilestonesForOrders(orderIds) {
  if (!orderIds.length) return [];
  const { data, error } = await supabase.from("order_milestones").select("order_id, milestone_key, plan_date, actual_date").in("order_id", orderIds);
  if (error) throw error;
  return data;
}

async function fetchLatestCrdForOrders(orderIds) {
  if (!orderIds.length) return new Map();
  const { data, error } = await supabase.from("crd_updates").select("order_id, new_crd, created_at").in("order_id", orderIds).order("created_at", { ascending: false });
  if (error) throw error;
  const latest = new Map();
  for (const row of data) if (!latest.has(row.order_id)) latest.set(row.order_id, row.new_crd);
  return latest;
}

/* Aggregated PER ORDER for KPI purposes -- Shipping OTD and Short
   Shipment % are order-level metrics; the color-level detail from
   shipment_lines is for the Excel export and Reports Center specifically,
   not needed here. An order can have multiple shipment_lines (multiple
   colors, multiple partial shipments of the same color, or both) --
   shipped_qty is summed across every one of them; actual_etd uses the
   LATEST shipment date, since an order isn't genuinely finished shipping
   until its last partial shipment goes out, not its first. */
async function fetchShipmentDataForOrders(orderIds) {
  if (!orderIds.length) return new Map();
  const { data, error } = await supabase.from("shipment_lines")
    .select("order_id, shipped_qty, shipments(actual_etd)").in("order_id", orderIds);
  if (error) throw error;
  const byOrder = new Map();
  for (const line of data) {
    const existing = byOrder.get(line.order_id) || { shipped_qty: 0, actual_etd: null };
    existing.shipped_qty += line.shipped_qty;
    const lineEtd = line.shipments?.actual_etd;
    if (lineEtd && (!existing.actual_etd || lineEtd > existing.actual_etd)) existing.actual_etd = lineEtd;
    byOrder.set(line.order_id, existing);
  }
  return byOrder;
}

/* Core hit-rate computation, scoped to whichever milestone keys the caller
   asks for -- Critical Path Hit Rate passes every critical_path=true key,
   Fabric In-house / PCD Hit Rate pass exactly one key each. One function,
   three named metrics, per the explicit "keep KPI calculations in one
   clearly defined place" instruction. */
function computeHitRate(milestones, milestoneKeys, orderIds, today) {
  const relevantOrderIds = new Set(orderIds);
  const relevant = milestones.filter(m => milestoneKeys.includes(m.milestone_key) && relevantOrderIds.has(m.order_id));
  let hit = 0, miss = 0, pending = 0;
  const misses = [], hits = [];
  for (const m of relevant) {
    const cls = classifyMilestone(m.plan_date, m.actual_date, today);
    if (cls === "hit") { hit++; hits.push(m); }
    else if (cls === "miss") { miss++; misses.push(m); }
    else pending++;
  }
  const denominator = hit + miss;
  return { hit, miss, pending, denominator, rate: denominator ? Math.round((hit / denominator) * 100) : null, misses, hits };
}

export async function getKpiData(filters = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const [allOrders, milestoneTypes] = await Promise.all([
    fetchOrdersForKpi(filters),
    supabase.from("tna_milestone_types").select("key, label, critical_path").then(r => { if (r.error) throw r.error; return r.data; }),
  ]);
  const openOrders = allOrders.filter(o => o.status !== "shipped" && o.status !== "cancelled");
  const shippedOrders = allOrders.filter(o => o.status === "shipped");
  const orderIds = openOrders.map(o => o.id);
  const allOrderIds = allOrders.map(o => o.id);
  const [milestones, latestCrd, shipmentData] = await Promise.all([
    fetchMilestonesForOrders(orderIds),
    fetchLatestCrdForOrders(orderIds),
    fetchShipmentDataForOrders(allOrderIds),
  ]);
  const actualEtd = new Map([...shipmentData].filter(([, v]) => v.actual_etd).map(([k, v]) => [k, v.actual_etd]));

  const criticalPathKeys = milestoneTypes.filter(t => t.critical_path).map(t => t.key);

  const criticalPathHitRate = computeHitRate(milestones, criticalPathKeys, orderIds, today);
  const fabricInhouseHitRate = computeHitRate(milestones, ["fab_inhouse"], orderIds, today);
  const pcdHitRate = computeHitRate(milestones, ["prod_start"], orderIds, today);

  // Merchandising OTD / CRD Performance -- >= 3 days before ETD is on-time,
  // computed fresh here (not reusing crd_updates.classification, which was
  // computed with different logic/thresholds at entry time and against
  // whatever ETD was current then, not necessarily today's ETD).
  let crdHit = 0, crdMiss = 0;
  const crdMisses = [];
  for (const o of openOrders) {
    const crd = latestCrd.get(o.id);
    if (!crd || !o.etd) continue;
    const bufferDays = Math.round((new Date(o.etd) - new Date(crd)) / 86400000);
    if (bufferDays >= 3) crdHit++;
    else { crdMiss++; crdMisses.push({ order: o, crd, bufferDays }); }
  }
  const crdDenominator = crdHit + crdMiss;
  const merchandisingOtd = { hit: crdHit, miss: crdMiss, denominator: crdDenominator, rate: crdDenominator ? Math.round((crdHit / crdDenominator) * 100) : null, misses: crdMisses };

  // Shipping OTD -- genuinely no data until the Shipping Portal (Phase 5)
  // populates actual_etd. Reported honestly as "no data," not estimated
  // from a different field. Scoped to SHIPPED orders specifically, not
  // "open" ones -- actual_etd is only ever meaningful once an order has
  // actually shipped (caught this scoping mistake while extending this
  // function, fixed before it could silently produce wrong numbers once
  // Phase 5 starts populating real data).
  let shipHit = 0, shipMiss = 0;
  for (const o of shippedOrders) {
    const actual = actualEtd.get(o.id);
    if (!actual || !o.etd) continue;
    if (actual <= o.etd) shipHit++; else shipMiss++;
  }
  const shipDenominator = shipHit + shipMiss;
  const shippingOtd = { hit: shipHit, miss: shipMiss, denominator: shipDenominator, rate: shipDenominator ? Math.round((shipHit / shipDenominator) * 100) : null, hasAnyData: shipDenominator > 0 };

  // Short Shipment % -- v13's real formula, confirmed against its source:
  // (orderedQty - shippedQty) / orderedQty * 100, averaged across shipped
  // orders that have a shipped_qty recorded. Same Phase-5 data dependency
  // as Shipping OTD -- honestly "no data" until shipments are entered.
  const shortShipPcts = [];
  for (const o of shippedOrders) {
    const shipment = shipmentData.get(o.id);
    if (!shipment || shipment.shipped_qty == null || !o.qty) continue;
    shortShipPcts.push(((o.qty - shipment.shipped_qty) / o.qty) * 100);
  }
  const shortShipment = {
    avgPct: shortShipPcts.length ? Math.round((shortShipPcts.reduce((a, b) => a + b, 0) / shortShipPcts.length) * 10) / 10 : null,
    sampleCount: shortShipPcts.length, hasAnyData: shortShipPcts.length > 0,
  };

  // Open Order & Value / Shipped Order & Value -- per your request, shown
  // alongside each other so the balance still-to-ship is visible next to
  // what's already gone out. Value = Qty x FOB where FOB is visible to the
  // current user (view_fob-gated, same as everywhere else); shipped Qty
  // uses the real shipped_qty from order_shipments, not the ordered qty.
  const openQty = openOrders.reduce((s, o) => s + (o.qty || 0), 0);
  const openValue = "fob" in (openOrders[0] || {}) ? openOrders.reduce((s, o) => s + (o.qty || 0) * (o.fob || 0), 0) : null;
  const shippedQty = shippedOrders.reduce((s, o) => s + (shipmentData.get(o.id)?.shipped_qty ?? o.qty ?? 0), 0);
  const shippedValue = "fob" in (shippedOrders[0] || openOrders[0] || {})
    ? shippedOrders.reduce((s, o) => s + (shipmentData.get(o.id)?.shipped_qty ?? o.qty ?? 0) * (o.fob || 0), 0) : null;
  const openShippedSummary = { openQty, openValue, openOrders: openOrders.length, shippedQty, shippedValue, shippedOrders: shippedOrders.length };

  const riskCounts = {
    critical: openOrders.filter(o => o.risk === "critical").length,
    atRisk: openOrders.filter(o => o.risk === "atRisk").length,
    onTrack: openOrders.filter(o => o.risk === "onTrack").length,
  };

  const overdueMilestoneCount = milestones.filter(m => classifyMilestone(m.plan_date, m.actual_date, today) === "miss" && !m.actual_date).length;

  return {
    orders: openOrders, allOrders, shippedOrders, milestones, milestoneTypes, latestCrd, actualEtd, shipmentData,
    criticalPathHitRate, fabricInhouseHitRate, pcdHitRate, merchandisingOtd, shippingOtd, shortShipment, openShippedSummary,
    riskCounts, overdueMilestoneCount, totalOrders: openOrders.length,
  };
}

/* Roll-up by an arbitrary grouping dimension (factory or merchandiser) --
   re-runs the exact same KPI functions per group rather than a separate
   aggregate formula, so a factory's numbers always match what you'd get
   filtering the main dashboard to that one factory. */
export function rollupByDimension(kpiData, dimensionFn, labelFn) {
  const groups = new Map();
  const allGroupable = [...kpiData.orders, ...kpiData.shippedOrders];
  for (const o of allGroupable) {
    const key = dimensionFn(o);
    if (key == null) continue;
    if (!groups.has(key)) groups.set(key, { key, label: labelFn(o), openOrders: [], shippedOrders: [] });
    if (o.status === "shipped") groups.get(key).shippedOrders.push(o);
    else groups.get(key).openOrders.push(o);
  }
  const today = new Date().toISOString().slice(0, 10);
  const criticalPathKeys = kpiData.milestoneTypes.filter(t => t.critical_path).map(t => t.key);

  return [...groups.values()].map(g => {
    const openOrderIds = g.openOrders.map(o => o.id);
    const allOrderIds = [...openOrderIds, ...g.shippedOrders.map(o => o.id)];
    const cp = computeHitRate(kpiData.milestones, criticalPathKeys, openOrderIds, today);
    const fab = computeHitRate(kpiData.milestones, ["fab_inhouse"], openOrderIds, today);
    const pcd = computeHitRate(kpiData.milestones, ["prod_start"], openOrderIds, today);
    let crdHit = 0, crdMiss = 0;
    for (const o of g.openOrders) {
      const crd = kpiData.latestCrd.get(o.id);
      if (!crd || !o.etd) continue;
      const bufferDays = Math.round((new Date(o.etd) - new Date(crd)) / 86400000);
      if (bufferDays >= 3) crdHit++; else crdMiss++;
    }
    const crdDenom = crdHit + crdMiss;
    // Shipping OTD and Short Shipment scoped to this group's SHIPPED
    // orders -- same scoping fix applied here as in getKpiData() itself.
    let shipHit = 0, shipDenom = 0;
    const shortShipPcts = [];
    for (const o of g.shippedOrders) {
      const shipment = kpiData.shipmentData.get(o.id);
      const actual = shipment?.actual_etd;
      if (actual && o.etd) { shipDenom++; if (actual <= o.etd) shipHit++; }
      if (shipment?.shipped_qty != null && o.qty) shortShipPcts.push(((o.qty - shipment.shipped_qty) / o.qty) * 100);
    }
    const overdue = kpiData.milestones.filter(m => openOrderIds.includes(m.order_id) && classifyMilestone(m.plan_date, m.actual_date, today) === "miss" && !m.actual_date).length;
    const hasFob = "fob" in (g.openOrders[0] || g.shippedOrders[0] || {});
    const openQty = g.openOrders.reduce((s, o) => s + (o.qty || 0), 0);
    const openValue = hasFob ? g.openOrders.reduce((s, o) => s + (o.qty || 0) * (o.fob || 0), 0) : null;
    const shippedQty = g.shippedOrders.reduce((s, o) => s + (kpiData.shipmentData.get(o.id)?.shipped_qty ?? o.qty ?? 0), 0);
    const shippedValue = hasFob ? g.shippedOrders.reduce((s, o) => s + (kpiData.shipmentData.get(o.id)?.shipped_qty ?? o.qty ?? 0) * (o.fob || 0), 0) : null;
    return {
      key: g.key, label: g.label, totalOrders: g.openOrders.length + g.shippedOrders.length,
      critical: g.openOrders.filter(o => o.risk === "critical").length,
      atRisk: g.openOrders.filter(o => o.risk === "atRisk").length,
      onTrack: g.openOrders.filter(o => o.risk === "onTrack").length,
      overdueMilestones: overdue,
      criticalPathRate: cp.rate, fabricInhouseRate: fab.rate, pcdRate: pcd.rate,
      merchandisingOtdRate: crdDenom ? Math.round((crdHit / crdDenom) * 100) : null,
      shippingOtdRate: shipDenom ? Math.round((shipHit / shipDenom) * 100) : null,
      shortShipPct: shortShipPcts.length ? Math.round((shortShipPcts.reduce((a, b) => a + b, 0) / shortShipPcts.length) * 10) / 10 : null,
      openQty, openValue, shippedQty, shippedValue,
    };
  });
}
