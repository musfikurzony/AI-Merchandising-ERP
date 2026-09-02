import { buildAdvisorDataset, defaultAudienceForRole, canSwitchAudience } from "./aiAssistantApi.js";
import {
  buildNotifications, summarise, startHere, workload, scopeOrders,
  NOTIFICATION_TYPES, SEVERITY,
} from "./notificationsApi.js";
import {
  computeBusinessSummary, computeOnTimeShipment, computeShortShipment,
  computeOnTimeBands, orderMetrics, getFiscalYear,
} from "./reportsApi.js";

/* ==========================================================================
   The Dashboard's composition layer.
   ==========================================================================
   This file contains NO business rules. Not one threshold, not one date
   comparison, not one definition of "late". Every number it returns is
   produced by a function that already existed and is already used by
   another screen:

     what is a problem   -> notificationsApi.js  (the AI Assistant's engine)
     what is the book    -> reportsApi.js        (Reports Center's functions)
     what data to load   -> aiAssistantApi.js    (paged and reconciled, v84)

   Its whole job is to decide, from a role and a period, WHICH of those
   existing results to show and how to label them. If a date comparison
   ever appears in this file, it is in the wrong place and belongs in the
   engine — that is the rule that keeps the Dashboard, the AI Assistant and
   Reports Center from ever disagreeing.

   A consequence worth stating plainly: when the AI Assistant says eight fit
   samples are overdue, the Dashboard says eight because it is reading the
   same array of rows, not because two functions happened to agree. */

/* --------------------------------------------------------------------------
   Views. A "view" is which slice of one computation a person sees.
   -------------------------------------------------------------------------- */

export const DASHBOARD_VIEWS = [
  ["management", "Management"],
  ["merchandiser", "Merchandiser"],
  ["shipping", "Shipping"],
];

/* Role picks the DEFAULT body; module permissions decide what is actually
   rendered inside it. The architecture is "permissions, not roles", so a
   merchandiser who has been given shipping access must be able to switch to
   the shipping view rather than being locked out by their job title.

   These deliberately DELEGATE to the AI Assistant's existing mapping rather
   than declaring a second one. A dashboard view and an assistant audience
   are the same concept — which slice of one computation a person sees — and
   two mappings would eventually disagree about one role and put two
   different numbers on two screens for the same login. */
export const dashboardViewForRole = defaultAudienceForRole;
export const canSwitchView = canSwitchAudience;

/* A merchandiser's dashboard is about THEIR orders. Everyone else's is
   about the business. This is the only place that choice is made. */
export function defaultOnlyMine(role) {
  return role === "merchandiser" || role === "qa";
}

/* --------------------------------------------------------------------------
   Loading.
   -------------------------------------------------------------------------- */

/* A dashboard is a landing page: it must be quick, and it must not try to
   pull ten years of history into a browser because the database happens to
   hold it. The period filter does most of that work (the default is the
   current fiscal year), and this ceiling catches the rest — an honest
   "narrow the period" beats a frozen tab. */
export const MAX_CLIENT_ORDERS = 20000;

export async function buildDashboard(filters = {}, { userId = null, onlyMine = false } = {}) {
  const ds = await buildAdvisorDataset(filters);
  if (ds.orders.length > MAX_CLIENT_ORDERS) {
    return { ds, oversized: true, result: null, summary: null, plan: [], loads: [] };
  }
  const result = buildNotifications(ds, { userId, onlyMine });
  return { ds, oversized: false, result, summary: summarise(result), plan: startHere(result ? summarise(result) : null) };
}

/* --------------------------------------------------------------------------
   Scoping the engine's rows to a view.
   -------------------------------------------------------------------------- */

/* Exactly the rule the AI Assistant uses, so the two screens scope
   identically. Management sees everything; the others see their own
   audience plus anything marked "both". */
export function scopeRows(rows, view) {
  if (!rows) return [];
  if (view === "management") return rows;
  return rows.filter(r => {
    const a = NOTIFICATION_TYPES[r.type].audience;
    return a === view || a === "both";
  });
}

/* --------------------------------------------------------------------------
   KPI tiles.
   -------------------------------------------------------------------------- */

/* Tone is a presentation concern, not a severity judgement: the engine
   decides what is critical, this only decides what colour a tile is. */
const money = n => "$" + Math.round(n || 0).toLocaleString("en-US");

function typeCount(rowsByType, type) {
  return (rowsByType.get(type) || []).length;
}
function typePos(rowsByType, type) {
  return new Set((rowsByType.get(type) || []).map(r => r.po)).size;
}

export function groupRowsByType(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.type)) m.set(r.type, []);
    m.get(r.type).push(r);
  }
  return m;
}

/* POs that raised no notification at all. Not a new rule — it is the
   complement of the engine's own output over the same order set. */
export function onTrackPos(ds, rows, scope = {}) {
  const flagged = new Set(rows.map(r => r.po));
  const all = new Set(scopeOrders(ds, scope).map(o => `${o.po_prefix}${o.po_number}`));
  let n = 0;
  for (const po of all) if (!flagged.has(po)) n++;
  return n;
}

export const MILESTONE_CATEGORIES = ["Sampling", "Approvals", "Materials", "Production"];

/* The twelve management tiles. Every one of them traces to an existing
   function; the links are the point, so a number is never a dead end. */
export function managementTiles(ds, rows, summary, scope = {}) {
  const orders = scopeOrders(ds, scope);
  const byType = groupRowsByType(rows);
  const business = computeBusinessSummary(orders, ds.shipmentSummaryByOrder);
  const otd = computeOnTimeShipment(orders, ds.shipmentSummaryByOrder);
  const short = computeShortShipment(orders, ds.shipmentSummaryByOrder);
  /* Expressed the way management reads it: what share of the orders that
     actually shipped went short. computeShortShipment supplies both
     numbers; this only divides them. */
  const shortPct = short.shippedOrderCount ? Math.round((short.shortCount / short.shippedOrderCount) * 1000) / 10 : null;

  const dueSoon = (byType.get("shipping_window") || []).filter(r => r.daysRemaining != null && r.daysRemaining <= 7);
  /* "Milestone issues" is everything on the critical path before the goods
     leave: sampling, approvals, materials and production. The categories are
     the engine's own, so adding a notification type to one of them adds it
     to this tile automatically — no list here to keep in step. */
  const milestoneRows = rows.filter(r => MILESTONE_CATEGORIES.includes(NOTIFICATION_TYPES[r.type].category));

  return [
    { key: "activePo", label: "Active PO", value: business.open.count, sub: `${business.poCount.toLocaleString()} PO in period`, to: "/orders" },
    { key: "qty", label: "Order Qty", value: business.orderedQty, sub: `${business.shippedQty.toLocaleString()} pcs shipped`, format: "qty", to: "/reports" },
    { key: "value", label: "Order Value", value: business.orderValue, format: "money", sub: `${money(business.shipped.value)} shipped`, to: "/reports" },
    { key: "dueSoon", label: "PO Due Soon", value: new Set(dueSoon.map(r => r.po)).size, sub: "Ships within 7 days", tone: "attention", to: "/ai-assistant?type=shipping_window" },
    { key: "critical", label: "Critical", value: summary.poCountBySeverity.critical, sub: "PO needing action today", tone: "critical", to: "/ai-assistant?severity=critical" },
    { key: "attention", label: "At Risk", value: summary.poCountBySeverity.attention, sub: "PO to watch this week", tone: "attention", to: "/ai-assistant?severity=attention" },
    { key: "onTrack", label: "On Track", value: onTrackPos(ds, rows), sub: "PO with nothing outstanding", tone: "good", to: "/orders" },
    { key: "otd", label: "OTD", value: otd.rate, format: "pct", sub: otd.rate == null ? "No shipped orders in period" : `${otd.hit.toLocaleString()} of ${(otd.hit + otd.miss).toLocaleString()} shipped on time`, tone: otd.rate == null ? null : otd.rate >= 90 ? "good" : otd.rate >= 75 ? "attention" : "critical", to: "/reports/on-time" },
    { key: "short", label: "Short Shipment", value: shortPct, format: "pct", sub: `${short.shortCount.toLocaleString()} of ${short.shippedOrderCount.toLocaleString()} shipped orders short`, tone: shortPct != null && shortPct > 5 ? "attention" : "good", to: "/ai-assistant?type=short_shipment" },
    { key: "revisedEtd", label: "Revised ETD", value: typePos(byType, "etd_revision"), sub: "Needs confirmation", to: "/ai-assistant?type=etd_revision" },
    { key: "factory", label: "Factory Issues", value: typePos(byType, "no_factory"), sub: "No factory assigned", tone: typePos(byType, "no_factory") ? "critical" : "good", to: "/ai-assistant?type=no_factory" },
    { key: "milestone", label: "Milestone Issues", value: new Set(milestoneRows.map(r => r.po)).size, sub: `${milestoneRows.length.toLocaleString()} open milestone alert${milestoneRows.length === 1 ? "" : "s"}`, tone: "critical", to: "/ai-assistant?categories=" + MILESTONE_CATEGORIES.join(",") },
  ];
}

/* A merchandiser is not asking "how is the business" — they are asking
   "what is on my desk". Same engine, different question. */
export function merchandiserTiles(ds, rows, summary, scope = {}) {
  const orders = scopeOrders(ds, scope);
  const byType = groupRowsByType(rows);
  const business = computeBusinessSummary(orders, ds.shipmentSummaryByOrder);
  const window = byType.get("shipping_window") || [];
  const within = d => new Set(window.filter(r => r.daysRemaining != null && r.daysRemaining <= d).map(r => r.po)).size;

  return [
    { key: "myPo", label: "My Active PO", value: business.open.count, sub: `${business.poCount.toLocaleString()} PO in period`, to: "/orders?mine=1" },
    { key: "qty", label: "My Order Qty", value: business.orderedQty, format: "qty", sub: `${business.open.balanceQty.toLocaleString()} pcs still to ship`, to: "/orders?mine=1" },
    { key: "value", label: "My Order Value", value: business.orderValue, format: "money", sub: `${money(business.shipped.value)} shipped`, to: "/orders?mine=1" },
    { key: "d7", label: "Due ≤ 7 days", value: within(7), sub: "PO shipping this week", tone: "critical", to: "/ai-assistant?type=shipping_window" },
    { key: "d14", label: "Due ≤ 14 days", value: within(14), sub: "PO shipping this fortnight", tone: "attention", to: "/ai-assistant?type=shipping_window" },
    { key: "d30", label: "Due ≤ 30 days", value: within(30), sub: "PO shipping this month", to: "/ai-assistant?type=shipping_window" },
    { key: "critical", label: "My Critical Actions", value: summary.poCountBySeverity.critical, sub: "PO needing action today", tone: "critical", to: "/ai-assistant?severity=critical" },
    { key: "attention", label: "This Week", value: summary.poCountBySeverity.attention, sub: "PO to clear this week", tone: "attention", to: "/ai-assistant?severity=attention" },
  ];
}

/* Shipping asks a third question: what leaves, what is stuck, and what is
   wrong. The quantities come from the shipment lines the dataset already
   holds — shipment-level data, never flattened onto orders. */
export function shippingTiles(ds, rows, scope = {}) {
  const orders = scopeOrders(ds, scope);
  const byType = groupRowsByType(rows);
  const business = computeBusinessSummary(orders, ds.shipmentSummaryByOrder);
  const today = new Date().toISOString().slice(0, 10);
  const q = shipmentQuantities(ds, today);
  const window = byType.get("shipping_window") || [];

  return [
    { key: "today", label: "Shipped Today", value: q.today, format: "qty", sub: `${q.todayLines} shipment line${q.todayLines === 1 ? "" : "s"}`, tone: "good", to: "/shipping" },
    { key: "week", label: "This Week", value: q.week, format: "qty", sub: "pcs shipped", to: "/shipping" },
    { key: "mtd", label: "Month to Date", value: q.mtd, format: "qty", sub: "pcs shipped", to: "/shipping" },
    { key: "pending", label: "Pending Qty", value: business.open.balanceQty, format: "qty", sub: `across ${business.open.count.toLocaleString()} open PO`, tone: "attention", to: "/shipping" },
    { key: "due7", label: "ETD ≤ 7 days", value: new Set(window.filter(r => r.daysRemaining != null && r.daysRemaining <= 7).map(r => r.po)).size, sub: "PO due for shipment", tone: "attention", to: "/ai-assistant?type=shipping_window" },
    { key: "etdPassed", label: "ETD Passed", value: typePos(byType, "etd_passed"), sub: "Not fully shipped", tone: "critical", to: "/ai-assistant?type=etd_passed" },
    { key: "docs", label: "Invoices Pending", value: typePos(byType, "shipment_docs"), sub: "Shipment documentation gaps", tone: "attention", to: "/ai-assistant?type=shipment_docs" },
    { key: "short", label: "Short Shipment", value: typePos(byType, "short_shipment"), sub: "Split or close decision", tone: "critical", to: "/ai-assistant?type=short_shipment" },
    { key: "split", label: "Split Delivery", value: typePos(byType, "split_delivery"), sub: "Linked delivery sequences", to: "/ai-assistant?type=split_delivery" },
    { key: "invoice", label: "Ready to Invoice", value: typePos(byType, "ready_to_invoice"), sub: "Shipped, awaiting paperwork", tone: "good", to: "/ai-assistant?type=ready_to_invoice" },
  ];
}

/* Shipment quantities by when the goods actually left, read from the same
   shipment_lines rows every shipping report reads. Deliberately shipment-
   level: an order's quantity is not "shipped today" because the order is
   open today. */
export function shipmentQuantities(ds, today = new Date().toISOString().slice(0, 10)) {
  const d = new Date(today + "T00:00:00Z");
  const dow = d.getUTCDay();                       // 0 = Sunday
  const weekStart = new Date(d); weekStart.setUTCDate(d.getUTCDate() - dow);
  const weekFrom = weekStart.toISOString().slice(0, 10);
  const monthFrom = today.slice(0, 8) + "01";

  let todayQty = 0, weekQty = 0, mtdQty = 0, todayLines = 0;
  for (const line of ds.shipmentLines || []) {
    const when = line.shipments?.actual_etd;
    if (!when) continue;
    const qty = line.shipped_qty || 0;
    if (when === today) { todayQty += qty; todayLines++; }
    if (when >= weekFrom && when <= today) weekQty += qty;
    if (when >= monthFrom && when <= today) mtdQty += qty;
  }
  return { today: todayQty, todayLines, week: weekQty, mtd: mtdQty, weekFrom, monthFrom };
}

/* --------------------------------------------------------------------------
   The compact "today" block.
   -------------------------------------------------------------------------- */

/* Five to ten items, never twenty cards — the Dashboard is the summary and
   the AI Assistant is the detail. The ordering is the engine's own
   startHere(), so the Dashboard's priorities and the control tower's are
   the same priorities. */
export function todayBlock(rows, limit = 10) {
  const summary = summarise({ rows, ordersInScope: 0 });
  const bySeverity = { critical: [], attention: [], warning: [] };
  for (const t of summary.types) {
    if (!bySeverity[t.severity]) continue;
    bySeverity[t.severity].push({
      type: t.type, label: t.label, count: t.count, poCount: t.poCount, qty: t.qty,
      severity: t.severity, dot: SEVERITY[t.severity].dot,
      to: `/ai-assistant?type=${t.type}&severity=${t.severity}`,
    });
  }
  const total = summary.types.reduce((a, t) => a + t.count, 0);
  return {
    critical: bySeverity.critical.slice(0, limit),
    attention: bySeverity.attention.slice(0, limit),
    warning: bySeverity.warning.slice(0, limit),
    hiddenCritical: Math.max(0, bySeverity.critical.length - limit),
    hiddenAttention: Math.max(0, bySeverity.attention.length - limit),
    total,
  };
}

/* --------------------------------------------------------------------------
   Business overview — who carries the load.
   -------------------------------------------------------------------------- */

export function overviewBy(rows, dimension) {
  return workload({ rows }, dimension);
}

/* --------------------------------------------------------------------------
   Order-book distribution, for the overview tables.
   -------------------------------------------------------------------------- */

export function distributionBy(ds, keyFn, labelFn, limit = 6) {
  const groups = new Map();
  for (const o of ds.orders) {
    const k = keyFn(o) || "—";
    if (!groups.has(k)) groups.set(k, { label: labelFn ? labelFn(o) || k : k, poCount: 0, qty: 0, value: 0, pos: new Set() });
    const g = groups.get(k);
    const m = orderMetrics(o, ds.shipmentSummaryByOrder);
    g.pos.add(`${o.po_prefix}${o.po_number}`);
    g.qty += m.orderedQty;
    g.value += m.orderValue;
  }
  return [...groups.values()]
    .map(g => ({ ...g, poCount: g.pos.size }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, limit);
}

/* --------------------------------------------------------------------------
   Performance, for the management strip.
   -------------------------------------------------------------------------- */

/* On-time delivery month by month. Note what this does NOT do: it does not
   define on-time. It buckets the orders by ETD month and hands each bucket
   to computeOnTimeShipment — the same function Reports Center and the
   On-Time Performance screen call — so a month's percentage here and the
   report's percentage are the same calculation applied to the same rows. */
export function otdTrend(ds, { months = 6 } = {}) {
  const buckets = new Map();
  for (const o of ds.orders) {
    const basis = o.etd;
    if (!basis) continue;
    const key = String(basis).slice(0, 7);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(o);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-months)
    .map(([month, orders]) => {
      const otd = computeOnTimeShipment(orders, ds.shipmentSummaryByOrder);
      return {
        month,
        label: new Date(month + "-01T00:00:00Z").toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" }),
        rate: otd.rate,
        onTime: otd.hit,
        late: otd.miss,
        compared: otd.hit + otd.miss,
      };
    })
    .filter(m => m.compared > 0);
}

/* Delay bands, straight from the On-Time Performance screen's own
   function — on-time / ≤1 week / 1–2 weeks / >2 weeks. */
export function deliveryBands(ds) {
  return computeOnTimeBands(ds.orders, ds.shipmentSummaryByOrder, "factory");
}

/* Which fiscal years the loaded orders actually span. Used to say honestly
   whether a growth comparison is even possible. */
export function fiscalYearsIn(ds) {
  const years = new Set();
  for (const o of ds.orders) {
    const fy = getFiscalYear(o.etd);
    if (fy) years.add(fy);
  }
  return [...years].sort();
}
