import { orderMetrics } from "./reportsApi.js";

/* ==========================================================================
   The notification engine — one typed row, one severity scale, one place
   ==========================================================================

   Phase 2 of the Operational Control Tower. Three principles, each chosen
   because the alternative has already caused a problem somewhere:

   1. ONE ROW SHAPE. Every notification — whatever rule produced it — is the
      same flat object carrying the full business context (PO, style, colour,
      product group, category, label, business unit, customer, factory,
      merchandiser, quantities, every relevant date, days over/remaining,
      severity, recommended action, and where clicking it should go). The
      screen, the detail list and the Excel export then read ONE shape, so a
      column that exists on screen cannot be missing from the export.

   2. FACTS COMPUTED ONCE. Each order is reduced to a `facts` object in a
      single pass — production start, PP, fabric, fit, ex-factory, CRD,
      shipped/balance. Rules are then cheap predicates over those facts
      rather than repeated scans of the milestone array. At 10,000 orders
      that is the difference between a screen and a stall.

   3. NO SECOND CALCULATION LAYER. Quantities come from `orderMetrics()` —
      the same function Reports Center, the Executive Dashboard and On-Time
      Performance use. If this file computed "shipped" its own way, the
      control tower and the reports would eventually disagree, and the
      first time management noticed, they would stop trusting both.
   ========================================================================== */

const DAY = 86400000;
const iso = d => (d instanceof Date ? d.toISOString().slice(0, 10) : d);
export const daysBetween = (later, earlier) =>
  later && earlier ? Math.round((new Date(iso(later)) - new Date(iso(earlier))) / DAY) : null;

/* --- severity ------------------------------------------------------------
   Four levels, standard across the application. Rank orders them; the label
   and colour token come from here so a rule can never invent a fifth. */
export const SEVERITY = {
  critical:  { key: "critical",  rank: 0, label: "Critical",  dot: "🔴", token: "var(--band-late)",   badge: "bad" },
  attention: { key: "attention", rank: 1, label: "Attention", dot: "🟠", token: "var(--band-w2)",     badge: "bad" },
  warning:   { key: "warning",   rank: 2, label: "Warning",   dot: "🟡", token: "var(--band-w1)",     badge: "neutral" },
  normal:    { key: "normal",    rank: 3, label: "Normal",    dot: "🟢", token: "var(--band-ontime)", badge: "good" },
};
export const SEVERITY_ORDER = ["critical", "attention", "warning", "normal"];

/* --- where a notification sends you --------------------------------------
   Every row carries its own destination, resolved from the rule that made
   it. "Open the Orders list and search again" is exactly the wasted click
   this exists to remove. */
function orderLink(orderId, tab, milestoneKey) {
  const params = new URLSearchParams();
  if (tab) params.set("tab", tab);
  if (milestoneKey) params.set("milestone", milestoneKey);
  const q = params.toString();
  return `/orders/${orderId}${q ? `?${q}` : ""}`;
}

/* ==========================================================================
   Per-order facts — computed once per order, read by every rule
   ========================================================================== */

function pickMilestone(list, key) {
  if (!key) return null;
  const rows = (list || []).filter(m => m.milestone_key === key);
  if (!rows.length) return null;
  // Order-level rows (no colour) win; otherwise the earliest planned colour
  // row represents the order's own deadline.
  const orderLevel = rows.find(m => !m.color_way_name);
  if (orderLevel) return orderLevel;
  return rows.slice().sort((a, b) => String(a.plan_date || "9999").localeCompare(String(b.plan_date || "9999")))[0];
}

function isApproved(m) {
  if (!m) return false;
  const s = String(m.status || "").toLowerCase();
  return !!m.actual_date || s === "approved" || s === "completed" || s === "done";
}

export function buildOrderFacts(ds, order, today) {
  const ms = ds.milestonesByOrder.get(order.id) || [];
  const k = ds.keys || {};
  const metrics = orderMetrics(order, ds.shipmentSummaryByOrder);
  const summary = ds.shipmentSummaryByOrder.get(order.id);

  const prodStart = pickMilestone(ms, k.prodStart?.key);
  const pp = pickMilestone(ms, k.ppSample?.key);
  const fabric = pickMilestone(ms, k.fabricInhouse?.key) || pickMilestone(ms, k.fabricEtd?.key);
  const fit = pickMilestone(ms, k.fitSample?.key);
  const exFactory = pickMilestone(ms, k.exFactory?.key);

  const prodStartPlan = prodStart?.plan_date || null;
  /* The fabric target is DERIVED, not stored: fabric must be in-house a week
     before production starts. If the T&A also carries its own fabric plan
     date, the earlier of the two governs — a factory's own plan cannot move
     the deadline later than the rule allows. */
  const fabricRuleTarget = prodStartPlan
    ? iso(new Date(new Date(prodStartPlan).getTime() - 7 * DAY))
    : null;
  const fabricTarget = fabric?.plan_date && fabricRuleTarget
    ? (fabric.plan_date < fabricRuleTarget ? fabric.plan_date : fabricRuleTarget)
    : (fabric?.plan_date || fabricRuleTarget);

  const etd = order.etd || null;
  const revisedEtd = order.revised_etd || null;
  const effectiveEtd = revisedEtd || etd;
  const crdRow = ds.crdLatestRow?.get(order.id) || null;
  const crdHistory = ds.crdHistoryByOrder?.get(order.id) || [];

  return {
    order, metrics,
    latestActualEtd: summary?.latestActualEtd || null,
    shipmentLineCount: summary?.lineCount || 0,

    prodStartPlan,
    prodStartActual: prodStart?.actual_date || null,
    prodStartMilestone: prodStart,

    ppPlan: pp?.plan_date || null,
    ppActual: pp?.actual_date || null,
    ppStatus: pp?.status || null,
    ppApproved: isApproved(pp),
    ppMilestone: pp,

    fabricTarget,
    fabricPlan: fabric?.plan_date || null,
    fabricActual: fabric?.actual_date || null,
    fabricInHouse: !!fabric?.actual_date,
    fabricMilestone: fabric,

    fitPlan: fit?.plan_date || null,
    fitActual: fit?.actual_date || null,
    fitSubmitted: !!fit?.actual_date,
    fitMilestone: fit,

    exFactoryActual: exFactory?.actual_date || null,

    etd, revisedEtd, effectiveEtd,
    crd: crdRow?.new_crd || null,
    previousCrd: crdRow?.previous_crd || null,
    crdChangeCount: crdHistory.length,

    daysSinceReceipt: order.order_rcv_date ? daysBetween(today, order.order_rcv_date) : null,
    daysToEtd: effectiveEtd ? daysBetween(effectiveEtd, today) : null,
    isOpen: order.status !== "shipped" && order.status !== "cancelled",
  };
}

/* ==========================================================================
   The typed notification row
   ========================================================================== */

function notification(type, severity, facts, fields = {}) {
  const o = facts.order;
  const def = NOTIFICATION_TYPES[type];
  return {
    id: `${type}:${o.id}${fields.color ? `:${fields.color}` : ""}`,
    type, typeLabel: def.label, category: def.category, audience: def.audience,
    severity, severityRank: SEVERITY[severity].rank,

    orderId: o.id,
    po: `${o.po_prefix}${o.po_number}`,
    style: o.style || "",
    color: fields.color || "",
    deliverySequence: o.delivery_sequence || 1,

    productGroup: o.product_groups?.name || "",
    productCategory: o.product_categories?.name || "",
    label: o.labels?.name || "",
    businessUnit: o.business_units?.name || "",
    division: o.divisions?.name || "",
    customer: o.customers?.name || "",
    season: o.season || "",
    factory: o.factories?.name || "Unassigned",
    factoryCode: o.factory_code || "",
    merchandiser: o.profiles?.full_name || "Unassigned",
    merchandiserId: o.primary_merchandiser_id || "",

    orderQty: facts.metrics.orderedQty,
    shippedQty: facts.metrics.shippedQty,
    balanceQty: facts.metrics.balanceQty,

    orderRcvDate: o.order_rcv_date || "",
    productionStartDate: facts.prodStartPlan || "",
    productionStartActual: facts.prodStartActual || "",
    etd: facts.etd || "",
    revisedEtd: facts.revisedEtd || "",
    crd: facts.crd || "",
    previousCrd: facts.previousCrd || "",

    milestone: fields.milestone || "",
    plannedDate: fields.plannedDate || "",
    actualDate: fields.actualDate || "",

    daysPassed: fields.daysPassed ?? null,
    daysRemaining: fields.daysRemaining ?? null,
    daysDelayed: fields.daysDelayed ?? null,

    risk: o.risk || "",
    orderStatus: o.status || "",
    currentStatus: fields.currentStatus || "",
    detail: fields.detail || "",
    recommendedAction: fields.recommendedAction || def.defaultAction,
    link: fields.link || orderLink(o.id, def.tab, fields.milestoneKey || def.milestoneKey),
  };
}

/* ==========================================================================
   The catalogue — each type declares where clicking it goes, and what the
   person is supposed to DO about it
   ========================================================================== */

export const NOTIFICATION_TYPES = {
  no_factory: {
    label: "Factory not assigned", category: "Setup", audience: "merchandiser", tab: "factory",
    blurb: "No factory assigned — the T&A cannot start",
    defaultAction: "Assign a factory so the T&A can be planned.",
  },
  fit_sample: {
    label: "Fit sample not submitted", category: "Sampling", audience: "merchandiser", tab: "tna",
    blurb: "Counted from the order received date, not from a plan date that may never have been set",
    defaultAction: "Chase the factory for the fit sample today.",
  },
  pp_approval: {
    label: "PP approval before production", category: "Approvals", audience: "merchandiser", tab: "tna",
    blurb: "PP must be approved before production starts",
    defaultAction: "Get the PP sample submitted and approved before production starts.",
  },
  fabric_inhouse: {
    label: "Fabric in-house", category: "Materials", audience: "merchandiser", tab: "tna",
    blurb: "Fabric must be in-house a week before production starts",
    defaultAction: "Get a committed in-house date from the mill.",
  },
  prod_start_passed: {
    label: "Production start date passed", category: "Production", audience: "merchandiser", tab: "tna",
    blurb: "The planned production start has passed with no actual start recorded",
    defaultAction: "Confirm with the factory whether production actually started, and record the date.",
  },
  etd_passed: {
    label: "ETD passed", category: "Shipping", audience: "both", tab: "shipment",
    blurb: "The ETD has passed and the order is not fully shipped",
    defaultAction: "Confirm the real ex-factory date with the factory and tell the buyer.",
  },
  shipping_window: {
    label: "Shipping soon", category: "Shipping", audience: "merchandiser", tab: "shipment",
    blurb: "Ships within 7 / 14 / 30 days",
    defaultAction: "Confirm ex-factory, inspection and booking.",
  },
  crd_risk: {
    label: "CRD missing or too close to ETD", category: "Delivery", audience: "merchandiser", tab: "overview",
    blurb: "A CRD needs at least three days of buffer before ETD",
    defaultAction: "Confirm a CRD at least 3 days before ETD.",
  },
  etd_revision: {
    label: "ETD revised", category: "Delivery", audience: "merchandiser", tab: "overview",
    blurb: "The ETD has been changed from the original",
    defaultAction: "Confirm the revised date is agreed with the buyer and with shipping.",
  },
  short_shipment: {
    label: "Short shipment", category: "Shipping", audience: "shipping", tab: "shipment",
    blurb: "Shipped quantity is below the ordered quantity",
    defaultAction: "Decide with merchandising: split the balance as a further delivery, or close the order short.",
  },
  split_delivery: {
    label: "Split delivery balance", category: "Shipping", audience: "shipping", tab: "shipment",
    blurb: "A later delivery carries the balance of an earlier one",
    defaultAction: "Confirm the balance delivery's own ETD and keep it tracked.",
  },
  ready_to_invoice: {
    label: "Left factory, no shipment entered", category: "Shipping", audience: "shipping", tab: "shipment",
    blurb: "Ex-factory is recorded but no shipment line exists",
    defaultAction: "Create the shipment and enter the invoice.",
  },
  shipment_docs: {
    label: "Shipment documentation incomplete", category: "Shipping", audience: "shipping", tab: "shipment",
    blurb: "Invoice number, actual ETD, vessel or destination is missing",
    defaultAction: "Complete the shipment header so the invoice report and the buyer's ASN are correct.",
  },
  approval_rejected: {
    label: "Submission rejected", category: "Approvals", audience: "merchandiser", tab: "samples",
    blurb: "A lab dip, strike-off or sample was rejected — the cycle restarts",
    defaultAction: "Confirm the correction with the factory in writing and re-book the submission.",
  },
  awaiting_approval: {
    label: "Waiting on buyer approval", category: "Approvals", audience: "merchandiser", tab: "samples",
    blurb: "Submitted but still unapproved",
    defaultAction: "Push the buyer for a decision — nothing downstream can be committed while it sits.",
  },
};

/* ==========================================================================
   The rules — each takes the per-order facts and returns 0..n notifications
   ========================================================================== */

function ruleNoFactory(f, ctx) {
  if (!f.isOpen || f.order.factory_code) return [];
  const d = f.daysSinceReceipt;
  const near = f.daysToEtd != null && f.daysToEtd <= 45;
  return [notification("no_factory", near ? "critical" : "attention", f, {
    daysPassed: d,
    currentStatus: "Unassigned",
    detail: d != null
      ? `Waiting ${d} days since the order was received${near ? `, and it ships in ${f.daysToEtd} days` : ""}`
      : "No factory assigned",
    recommendedAction: near
      ? `Assign a factory today — this order ships in ${f.daysToEtd} days and no T&A exists yet.`
      : "Assign a factory so the T&A can be planned.",
  })];
}

/* A. Fit sample — measured from the ORDER RECEIVED DATE, because that is
   the date that always exists. A plan date that was never entered cannot
   make a genuinely late sample invisible. */
function ruleFitSample(f, ctx) {
  if (!f.isOpen || f.fitSubmitted) return [];
  if (!ctx.keys.fitSample) return [];
  if (!f.order.order_rcv_date) return [];
  const passed = f.daysSinceReceipt;
  if (passed == null || passed < 21) return [];
  const planOverdue = f.fitPlan ? daysBetween(ctx.today, f.fitPlan) : null;

  const severity = passed >= 60 ? "critical" : passed >= 35 ? "attention" : "warning";
  return [notification("fit_sample", severity, f, {
    milestone: ctx.keys.fitSample.label, milestoneKey: ctx.keys.fitSample.key,
    plannedDate: f.fitPlan || "", actualDate: "",
    daysPassed: passed,
    daysDelayed: planOverdue != null && planOverdue > 0 ? planOverdue : null,
    currentStatus: "Not submitted",
    detail: `Order received ${f.order.order_rcv_date} — ${passed} days passed, fit sample still not submitted`
      + (planOverdue != null && planOverdue > 0 ? ` (planned ${f.fitPlan}, ${planOverdue} days overdue)` : ""),
    recommendedAction: `Chase the factory for the fit sample today — ${passed} days have passed since the order was received and every later milestone slips behind it.`,
  })];
}

/* B. PP approval — windows measured against the PRODUCTION START date. */
function rulePpApproval(f, ctx) {
  if (!f.isOpen || !ctx.keys.ppSample) return [];
  if (f.ppApproved) return [];
  if (!f.prodStartPlan) return [];
  const toStart = daysBetween(f.prodStartPlan, ctx.today);   // + = still ahead
  if (toStart > 14) return [];                               // normal: no alert

  const started = f.prodStartActual || toStart < 0;
  const severity = toStart < 0 ? "critical" : toStart <= 0 ? "critical" : toStart <= 7 ? "attention" : "warning";
  const detail = toStart < 0
    ? `Production start ${f.prodStartPlan} passed ${Math.abs(toStart)} days ago and PP is still not approved`
    : toStart === 0
      ? `Production starts today and PP is not approved`
      : `Production starts in ${toStart} days and PP is not approved`;

  return [notification("pp_approval", severity, f, {
    milestone: ctx.keys.ppSample.label, milestoneKey: ctx.keys.ppSample.key,
    plannedDate: f.ppPlan || "", actualDate: f.ppActual || "",
    daysRemaining: toStart > 0 ? toStart : null,
    daysDelayed: toStart < 0 ? Math.abs(toStart) : null,
    currentStatus: f.ppActual ? `Submitted ${f.ppActual}${f.ppStatus ? ` · ${f.ppStatus}` : ""}` : "Not submitted",
    detail,
    recommendedAction: toStart < 0
      ? "Stop and confirm: production should not run against an unapproved PP. Get the approval or a written buyer waiver today."
      : `Get the PP approved before ${f.prodStartPlan} — production cannot legitimately start without it.`,
  })];
}

/* C. Fabric in-house — target is production start − 7 days. */
function ruleFabricInhouse(f, ctx) {
  if (!f.isOpen || f.fabricInHouse) return [];
  if (!f.fabricTarget) return [];
  const toTarget = daysBetween(f.fabricTarget, ctx.today);
  const startPassed = f.prodStartPlan ? daysBetween(ctx.today, f.prodStartPlan) > 0 : false;
  if (toTarget > 7 && !startPassed) return [];               // normal: no alert

  const severity = startPassed ? "critical" : toTarget < 0 ? "critical" : toTarget <= 7 ? "attention" : "warning";
  const detail = startPassed
    ? `Production start ${f.prodStartPlan} has passed and fabric is still not in-house (target was ${f.fabricTarget})`
    : toTarget < 0
      ? `Fabric was due in-house ${f.fabricTarget} — ${Math.abs(toTarget)} days ago`
      : `Fabric due in-house ${f.fabricTarget}, in ${toTarget} days`;

  return [notification("fabric_inhouse", severity, f, {
    milestone: ctx.keys.fabricInhouse?.label || "Fabric in-house",
    milestoneKey: ctx.keys.fabricInhouse?.key || ctx.keys.fabricEtd?.key,
    plannedDate: f.fabricTarget, actualDate: "",
    daysRemaining: toTarget > 0 ? toTarget : null,
    daysDelayed: toTarget < 0 ? Math.abs(toTarget) : null,
    currentStatus: "Not in-house",
    detail,
    recommendedAction: startPassed
      ? "Production cannot run without fabric. Get a dated in-house commitment from the mill today and re-plan the T&A against it."
      : `Confirm the mill's in-house date against the ${f.fabricTarget} target — fabric is the usual cause of a missed production start.`,
  })];
}

/* D. Production start passed with no actual start recorded. */
function ruleProdStartPassed(f, ctx) {
  if (!f.isOpen || !f.prodStartPlan || f.prodStartActual) return [];
  const late = daysBetween(ctx.today, f.prodStartPlan);
  if (late == null || late <= 0) return [];
  return [notification("prod_start_passed", "critical", f, {
    milestone: ctx.keys.prodStart?.label || "Production start",
    milestoneKey: ctx.keys.prodStart?.key,
    plannedDate: f.prodStartPlan, actualDate: "",
    daysDelayed: late,
    currentStatus: "Not started",
    detail: `Planned production start ${f.prodStartPlan} — ${late} days ago, no actual start recorded`
      + (f.fabricInHouse ? "" : "; fabric is not in-house either"),
    recommendedAction: `Confirm with ${f.order.factories?.name || "the factory"} whether production actually started. If it has, record the date; if it has not, the ETD is already at risk — escalate today.`,
  })];
}

function ruleEtdPassed(f, ctx) {
  if (!f.isOpen || !f.effectiveEtd) return [];
  const late = daysBetween(ctx.today, f.effectiveEtd);
  if (late == null || late <= 0) return [];
  const m = f.metrics;
  const fullyShipped = m.shippedQty > 0 && m.balanceQty <= 0;
  const detail = m.shippedQty <= 0
    ? `ETD ${f.effectiveEtd} passed ${late} days ago — nothing shipped`
    : fullyShipped
      ? `Fully shipped (${m.shippedQty.toLocaleString()} pcs) but still marked "${f.order.status}"`
      : `ETD ${f.effectiveEtd} passed ${late} days ago — ${m.balanceQty.toLocaleString()} of ${m.orderedQty.toLocaleString()} pcs still open`;
  return [notification("etd_passed", fullyShipped ? "attention" : "critical", f, {
    plannedDate: f.effectiveEtd, actualDate: f.latestActualEtd || "",
    daysDelayed: late,
    currentStatus: fullyShipped ? "Shipped, order not closed" : m.shippedQty > 0 ? "Partially shipped" : "Not shipped",
    detail,
    recommendedAction: fullyShipped
      ? "Close the order out — the goods have shipped but the status still says otherwise, which keeps it in every open-order report."
      : "Confirm the real ex-factory date with the factory, tell the buyer, and have shipping confirm booking and invoice.",
  })];
}

function ruleShippingWindow(f, ctx) {
  if (!f.isOpen || !f.effectiveEtd) return [];
  const d = f.daysToEtd;
  if (d == null || d < 0 || d > 30) return [];
  if (f.metrics.balanceQty <= 0) return [];
  const severity = d <= 7 ? "attention" : d <= 14 ? "warning" : "normal";
  if (severity === "normal") return [];   // 15–30 days is context, not an alert
  return [notification("shipping_window", severity, f, {
    plannedDate: f.effectiveEtd,
    daysRemaining: d,
    currentStatus: f.metrics.shippedQty > 0 ? `Partially shipped — ${f.metrics.balanceQty.toLocaleString()} pcs left` : "Not shipped",
    detail: `Ships in ${d} day${d === 1 ? "" : "s"} (ETD ${f.effectiveEtd}) — ${f.metrics.balanceQty.toLocaleString()} pcs still to ship`,
    recommendedAction: d <= 7
      ? "Confirm ex-factory, inspection and booking now — this ships within the week."
      : "Confirm the ex-factory date and book space.",
  })];
}

function ruleCrd(f, ctx) {
  if (!f.isOpen || !f.effectiveEtd) return [];
  const toEtd = f.daysToEtd;
  if (toEtd == null || toEtd < 0 || toEtd > 45) return [];
  const buffer = f.crd ? daysBetween(f.effectiveEtd, f.crd) : null;

  let severity = null, detail = "", status = "";
  if (!f.crd) {
    severity = toEtd <= 14 ? "attention" : "warning";
    detail = `No CRD recorded and ETD ${f.effectiveEtd} is ${toEtd} days away`;
    status = "CRD missing";
  } else if (buffer < 0) {
    severity = "critical";
    detail = `CRD ${f.crd} is AFTER the ETD ${f.effectiveEtd} by ${Math.abs(buffer)} days`;
    status = "CRD after ETD";
  } else if (buffer < 3) {
    severity = "attention";
    detail = `CRD ${f.crd} leaves only ${buffer} day${buffer === 1 ? "" : "s"} before ETD ${f.effectiveEtd} — under the 3-day rule`;
    status = `${buffer}-day buffer`;
  } else return [];

  return [notification("crd_risk", severity, f, {
    plannedDate: f.crd || "", actualDate: "",
    daysRemaining: toEtd,
    daysDelayed: buffer != null && buffer < 0 ? Math.abs(buffer) : null,
    currentStatus: status,
    detail: detail + (f.crdChangeCount > 1 ? ` · CRD changed ${f.crdChangeCount} times` : ""),
    recommendedAction: buffer != null && buffer < 0
      ? "A CRD after the ETD cannot be met as planned. Re-confirm both dates with the buyer today."
      : "Confirm a CRD at least 3 days before ETD — that buffer is what protects the delivery when anything slips.",
  })];
}

function ruleEtdRevision(f, ctx) {
  if (!f.isOpen || !f.revisedEtd || !f.etd || f.revisedEtd === f.etd) return [];
  const diff = daysBetween(f.revisedEtd, f.etd);
  return [notification("etd_revision", Math.abs(diff) >= 14 ? "attention" : "warning", f, {
    plannedDate: f.etd, actualDate: f.revisedEtd,
    daysDelayed: diff > 0 ? diff : null,
    daysRemaining: diff < 0 ? Math.abs(diff) : null,
    currentStatus: diff > 0 ? `Pushed out ${diff} days` : `Pulled in ${Math.abs(diff)} days`,
    detail: `Original ETD ${f.etd} → revised ${f.revisedEtd} (${diff > 0 ? "+" : ""}${diff} days)`
      + (f.crdChangeCount > 1 ? ` · CRD also changed ${f.crdChangeCount} times` : ""),
    recommendedAction: "Confirm the revised date is agreed with the buyer and with shipping — a revised ETD that only exists in the ERP is not an agreed date.",
  })];
}

/* Short shipment, at COLOUR level where colour data exists — the balance a
   merchandiser has to chase is per colour, not per order. */
function ruleShortShipment(f, ctx) {
  const m = f.metrics;
  if (m.shippedQty <= 0 || m.balanceQty <= 0) return [];
  const past = f.effectiveEtd ? daysBetween(ctx.today, f.effectiveEtd) > 0 : false;
  if (!past) return [];        // still inside the window — not short yet

  const shortPct = m.orderedQty ? Math.round((m.balanceQty / m.orderedQty) * 100) : 0;
  const severity = shortPct >= 10 ? "critical" : "attention";

  const colours = ctx.shippedByOrderColour.get(f.order.id) || new Map();
  const colourWays = ctx.colorWaysByOrder.get(f.order.id) || [];
  const detailByColour = colourWays.length
    ? colourWays.map(cw => {
        const shipped = colours.get(cw.name) || 0;
        return `${cw.name}: ${shipped.toLocaleString()}/${(cw.qty || 0).toLocaleString()}`;
      }).join(" · ")
    : "";

  return [notification("short_shipment", severity, f, {
    plannedDate: f.effectiveEtd, actualDate: f.latestActualEtd || "",
    daysDelayed: daysBetween(ctx.today, f.effectiveEtd),
    currentStatus: `Short by ${m.balanceQty.toLocaleString()} pcs (${shortPct}%)`,
    detail: `Shipped ${m.shippedQty.toLocaleString()} of ${m.orderedQty.toLocaleString()} — ${m.balanceQty.toLocaleString()} pcs short`
      + (detailByColour ? ` · ${detailByColour}` : "")
      + (f.shipmentLineCount > 1 ? ` · across ${f.shipmentLineCount} shipment lines` : ""),
    recommendedAction: "Decide with merchandising: split the balance as a further delivery so it keeps its own ETD and tracking, or close the order short. Leaving it undecided is what makes a balance disappear from everyone's view.",
  })];
}

/* Split deliveries — Delivery 2/3 created from an earlier short shipment.
   Uses `delivery_sequence` / `split_from_order_id`, which already exist. */
function ruleSplitDelivery(f, ctx) {
  const seq = f.order.delivery_sequence || 1;
  if (seq <= 1) return [];
  const m = f.metrics;
  const shipped = m.shippedQty > 0 && m.balanceQty <= 0;
  const past = f.effectiveEtd ? daysBetween(ctx.today, f.effectiveEtd) > 0 : false;
  const severity = shipped ? "normal" : past ? "critical" : "warning";
  if (severity === "normal") return [];

  return [notification("split_delivery", severity, f, {
    plannedDate: f.effectiveEtd || "",
    daysRemaining: f.daysToEtd != null && f.daysToEtd >= 0 ? f.daysToEtd : null,
    daysDelayed: past ? daysBetween(ctx.today, f.effectiveEtd) : null,
    currentStatus: shipped ? "Balance shipped" : past ? "Balance overdue" : "Balance expected",
    detail: `Delivery ${seq} carries ${m.orderedQty.toLocaleString()} pcs of the original PO`
      + (past ? ` — its own ETD ${f.effectiveEtd} has passed with ${m.balanceQty.toLocaleString()} pcs still open` : ` — due ${f.effectiveEtd || "date not set"}`),
    recommendedAction: past
      ? "This balance delivery is now late in its own right. Confirm a real date or close it as a shortage."
      : "Keep the balance delivery tracked to its own ETD — it is a real order, not a leftover.",
  })];
}

function ruleReadyToInvoice(f, ctx) {
  if (!f.isOpen || !f.exFactoryActual) return [];
  if (f.metrics.shippedQty > 0) return [];
  return [notification("ready_to_invoice", "critical", f, {
    milestone: ctx.keys.exFactory?.label || "Ex-factory",
    milestoneKey: ctx.keys.exFactory?.key,
    plannedDate: "", actualDate: f.exFactoryActual,
    daysPassed: daysBetween(ctx.today, f.exFactoryActual),
    currentStatus: "No shipment entered",
    detail: `Ex-factory recorded ${f.exFactoryActual} but no shipment line exists yet`,
    link: `/shipping`,
    recommendedAction: "Create the shipment and enter the invoice — until it exists, the goods are invisible to every report and to the buyer.",
  })];
}

function ruleShipmentDocs(f, ctx) {
  const gaps = ctx.docGapsByOrder.get(f.order.id);
  if (!gaps || !gaps.missing.size) return [];
  return [notification("shipment_docs", "warning", f, {
    currentStatus: `Missing ${[...gaps.missing].join(", ")}`,
    detail: `${gaps.qty.toLocaleString()} pcs already shipped, but the shipment is missing ${[...gaps.missing].join(", ")}`,
    link: `/shipping`,
    recommendedAction: "Complete the shipment header — the invoice report and the buyer's ASN both read those fields.",
  })];
}

function ruleApprovalOutcomes(f, ctx) {
  const ms = ctx.ds.milestonesByOrder.get(f.order.id) || [];
  const watch = [ctx.keys.labDip, ctx.keys.strikeOff, ctx.keys.topSample, ctx.keys.ppSample, ctx.keys.fitSample].filter(Boolean);
  if (!watch.length || !f.isOpen) return [];
  const keys = new Set(watch.map(w => w.key));
  const labelOf = k => (watch.find(w => w.key === k) || {}).label || k;
  const out = [];

  const rejected = ms.filter(m => keys.has(m.milestone_key) && ["rejected", "failed", "not approved"].includes(String(m.status || "").toLowerCase()));
  if (rejected.length) {
    out.push(notification("approval_rejected", "critical", f, {
      milestone: labelOf(rejected[0].milestone_key), milestoneKey: rejected[0].milestone_key,
      plannedDate: rejected[0].plan_date || "", actualDate: rejected[0].actual_date || "",
      color: rejected[0].color_way_name || "",
      currentStatus: "Rejected",
      detail: rejected.map(r => `${labelOf(r.milestone_key)}${r.color_way_name ? ` (${r.color_way_name})` : ""} rejected`).join(", "),
      recommendedAction: "A rejection restarts the sample cycle. Confirm the correction with the factory in writing and re-book the submission date.",
    }));
  }

  /* "Pending" is deliberately NOT in this list. It is the default status in
     the T&A grid, so a milestone with an actual date still reading "Pending"
     almost always means the date was entered and the status never changed —
     not that a buyer is deliberating. Including it made an ordinary completed
     milestone raise an approval alert on nearly every order. Only an explicit
     submitted / in-review / sent state counts as waiting. */
  const waiting = ms.filter(m => keys.has(m.milestone_key) && m.actual_date &&
    ["submitted", "in review", "in_review", "sent", "awaiting approval", "with buyer"].includes(String(m.status || "").toLowerCase()));
  if (waiting.length) {
    const oldest = waiting.reduce((a, b) => ((a.actual_date || "") < (b.actual_date || "") ? a : b));
    const age = daysBetween(ctx.today, oldest.actual_date);
    out.push(notification("awaiting_approval", age > 7 ? "attention" : "warning", f, {
      milestone: labelOf(oldest.milestone_key), milestoneKey: oldest.milestone_key,
      plannedDate: oldest.plan_date || "", actualDate: oldest.actual_date || "",
      color: oldest.color_way_name || "",
      daysPassed: age,
      currentStatus: oldest.status || "Submitted",
      detail: `${labelOf(oldest.milestone_key)}${oldest.color_way_name ? ` (${oldest.color_way_name})` : ""} submitted ${oldest.actual_date}, still unapproved after ${age} days`,
      recommendedAction: "Push the buyer for a decision — nothing downstream can be committed while an approval sits open.",
    }));
  }
  return out;
}

const RULES = [
  ruleNoFactory, ruleFitSample, rulePpApproval, ruleFabricInhouse, ruleProdStartPassed,
  ruleEtdPassed, ruleShippingWindow, ruleCrd, ruleEtdRevision,
  ruleShortShipment, ruleSplitDelivery, ruleReadyToInvoice, ruleShipmentDocs, ruleApprovalOutcomes,
];

/* ==========================================================================
   Build
   ========================================================================== */

/* "Only my orders" in one place. The Dashboard's KPI tiles need the same
   subset the notification rules run over — otherwise a merchandiser sees
   "My Active PO 198" (the whole company) above a list of their own 37
   alerts, which is worse than showing nothing. */
export function scopeOrders(ds, { userId = null, onlyMine = false } = {}) {
  return onlyMine && userId ? ds.orders.filter(o => o.primary_merchandiser_id === userId) : ds.orders;
}

export function buildNotifications(ds, { today = new Date().toISOString().slice(0, 10), userId = null, onlyMine = false } = {}) {
  const orders = scopeOrders(ds, { userId, onlyMine });

  /* Shipment-derived lookups built once, not per rule: shipped quantity per
     order+colour, and which shipments are missing documentation. */
  const shippedByOrderColour = new Map();
  const docGapsByOrder = new Map();
  for (const line of ds.shipmentLines) {
    if (!shippedByOrderColour.has(line.order_id)) shippedByOrderColour.set(line.order_id, new Map());
    const byColour = shippedByOrderColour.get(line.order_id);
    const c = line.color_way_name || "";
    byColour.set(c, (byColour.get(c) || 0) + (line.shipped_qty || 0));

    const h = line.shipments || {};
    const missing = [];
    if (!h.invoice_number) missing.push("invoice number");
    if (!h.actual_etd) missing.push("actual ETD");
    if (!h.vessel) missing.push("vessel");
    if (!h.destination_port) missing.push("destination");
    if (missing.length) {
      if (!docGapsByOrder.has(line.order_id)) docGapsByOrder.set(line.order_id, { missing: new Set(), qty: 0 });
      const g = docGapsByOrder.get(line.order_id);
      missing.forEach(x => g.missing.add(x));
      g.qty += line.shipped_qty || 0;
    }
  }

  const ctx = {
    ds, today, keys: ds.keys || {},
    shippedByOrderColour, docGapsByOrder,
    colorWaysByOrder: ds.colorWaysByOrder || new Map(),
  };

  const rows = [];
  const unavailable = [];
  if (!ctx.keys.fitSample) unavailable.push({ type: "fit_sample", reason: "No fit-sample milestone exists in your T&A catalog." });
  if (!ctx.keys.ppSample) unavailable.push({ type: "pp_approval", reason: "No PP-sample milestone exists in your T&A catalog." });
  if (!ctx.keys.fabricInhouse && !ctx.keys.fabricEtd) unavailable.push({ type: "fabric_inhouse", reason: "No fabric milestone exists in your T&A catalog." });
  if (!ctx.keys.prodStart) unavailable.push({ type: "prod_start_passed", reason: "No production-start milestone exists in your T&A catalog — PP and fabric windows depend on it too." });

  for (const order of orders) {
    const facts = buildOrderFacts(ds, order, today);
    for (const rule of RULES) {
      try { rows.push(...rule(facts, ctx)); }
      catch (e) { /* one bad row must never blank the whole control tower */ }
    }
  }

  rows.sort((a, b) =>
    a.severityRank - b.severityRank ||
    (b.daysDelayed ?? -1) - (a.daysDelayed ?? -1) ||
    a.po.localeCompare(b.po));

  return { rows, unavailable, ordersInScope: orders.length, today };
}

/* --- summaries, all derived from the same rows --------------------------- */

export function summarise(result) {
  const bySeverity = { critical: 0, attention: 0, warning: 0, normal: 0 };
  const byType = new Map();
  const posBySeverity = { critical: new Set(), attention: new Set(), warning: new Set(), normal: new Set() };

  for (const r of result.rows) {
    bySeverity[r.severity] += 1;
    posBySeverity[r.severity].add(r.po);
    if (!byType.has(r.type)) {
      byType.set(r.type, {
        type: r.type, label: r.typeLabel, category: r.category, audience: r.audience,
        severity: r.severity, count: 0, pos: new Set(), qty: 0, worstRank: r.severityRank,
        blurb: NOTIFICATION_TYPES[r.type].blurb,
      });
    }
    const t = byType.get(r.type);
    t.count += 1;
    t.pos.add(r.po);
    t.qty += r.orderQty || 0;
    if (r.severityRank < t.worstRank) { t.worstRank = r.severityRank; t.severity = r.severity; }
  }

  const types = [...byType.values()]
    .map(t => ({ ...t, poCount: t.pos.size }))
    .sort((a, b) => a.worstRank - b.worstRank || b.count - a.count);

  return {
    bySeverity,
    poCountBySeverity: Object.fromEntries(Object.entries(posBySeverity).map(([k, v]) => [k, v.size])),
    types,
    totalNotifications: result.rows.length,
    ordersInScope: result.ordersInScope,
  };
}

/* "Start Here" — the five things that most need doing, chosen by severity
   and size rather than by a fixed list of categories. */
export function startHere(summary, limit = 5) {
  return summary.types
    .filter(t => t.severity !== "normal")
    .slice(0, limit)
    .map((t, i) => ({
      n: i + 1, type: t.type, severity: t.severity, label: t.label,
      poCount: t.poCount, count: t.count, qty: t.qty,
      line: `${t.poCount} PO${t.poCount === 1 ? "" : "s"} — ${t.label}`,
    }));
}

/* Workload — the same notification rows, grouped by who has to act. */
export function workload(result, dimension = "factory") {
  const groups = new Map();
  const keyOf = r => dimension === "factory" ? (r.factory || "Unassigned") : (r.merchandiser || "Unassigned");
  for (const r of result.rows) {
    const k = keyOf(r);
    if (!groups.has(k)) groups.set(k, { label: k, critical: 0, attention: 0, warning: 0, pos: new Set(), qty: 0, overdue: 0, due7: 0, due14: 0 });
    const g = groups.get(k);
    if (r.severity !== "normal") g[r.severity] += 1;
    g.pos.add(r.po);
    if (r.daysDelayed != null && r.daysDelayed > 0) g.overdue += 1;
    if (r.daysRemaining != null && r.daysRemaining <= 7) g.due7 += 1;
    else if (r.daysRemaining != null && r.daysRemaining <= 14) g.due14 += 1;
  }
  return [...groups.values()]
    .map(g => ({ ...g, poCount: g.pos.size }))
    .sort((a, b) => b.critical - a.critical || b.attention - a.attention || b.poCount - a.poCount);
}

/* The full field set, in the order management reads it. Used by the detail
   table AND the Excel export, so the two cannot diverge. */
export const EXPORT_COLUMNS = [
  ["typeLabel", "Notification Type"], ["severityLabel", "Severity"],
  ["po", "PO"], ["style", "Style"], ["color", "Color"], ["deliverySequence", "Delivery Seq"],
  ["productGroup", "Product Group"], ["productCategory", "Product Category"], ["label", "Label"],
  ["businessUnit", "Business Unit"], ["division", "Division"], ["customer", "Customer"], ["season", "Season"],
  ["factory", "Factory"], ["merchandiser", "Merchandiser"],
  ["orderQty", "Order Qty"], ["shippedQty", "Shipped Qty"], ["balanceQty", "Balance Qty"],
  ["orderRcvDate", "Order Received Date"], ["productionStartDate", "Production Start Date"],
  ["productionStartActual", "Production Start Actual"],
  ["milestone", "Milestone"], ["plannedDate", "Planned Date"], ["actualDate", "Actual Date"],
  ["etd", "ETD"], ["revisedEtd", "Revised ETD"], ["crd", "CRD"], ["previousCrd", "Previous CRD"],
  ["daysPassed", "Days Passed"], ["daysRemaining", "Days Remaining"], ["daysDelayed", "Days Delayed"],
  ["risk", "Risk"], ["orderStatus", "Order Status"], ["currentStatus", "Current Status"],
  ["detail", "Detail"], ["recommendedAction", "Recommended Action"],
];

export function toExportRow(r) {
  const out = {};
  for (const [key, header] of EXPORT_COLUMNS) {
    out[header] = key === "severityLabel" ? SEVERITY[r.severity].label : (r[key] ?? "");
  }
  return out;
}

/* ==========================================================================
   Phase 6 — the management view: how is this week different from last week?
   ==========================================================================
   Deliberately NOT a second calculation layer. A point in the trend is the
   SAME engine run with `today` moved back, over the same loaded dataset, so a
   number in the trend and the number on the card are produced by identical
   code. Nothing here re-implements a threshold.

   One honest limitation, stated on screen rather than hidden: the comparison
   uses today's records. A PP sample approved yesterday is approved in the
   "three weeks ago" run too, because the ERP stores one actual date, not a
   history of it. That makes the trend a fair read of DATE-driven exposure
   (what was overdue, what was closing in) and an optimistic read of approval
   backlogs. Where an audit trail does exist — CRD revisions — the engine
   already uses the dated history, so those points are exact. */

export function shiftDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function trend(ds, {
  today = new Date().toISOString().slice(0, 10),
  points = 4, stepDays = 7, userId = null, onlyMine = false, audienceFilter = null,
} = {}) {
  const out = [];
  for (let i = points - 1; i >= 0; i--) {
    const asAt = shiftDays(today, -i * stepDays);
    const res = buildNotifications(ds, { today: asAt, userId, onlyMine });
    const rows = audienceFilter ? res.rows.filter(audienceFilter) : res.rows;
    const s = summarise({ ...res, rows });
    out.push({
      asAt,
      label: i === 0 ? "Now" : i === 1 ? `${stepDays}d ago` : `${i * stepDays}d ago`,
      critical: s.bySeverity.critical,
      attention: s.bySeverity.attention,
      warning: s.bySeverity.warning,
      total: s.totalNotifications,
      /* Distinct POs, not the sum of the per-severity counts: one PO is
         routinely critical for one reason and a warning for another, and
         adding the columns would report more POs than exist. */
      posAtRisk: new Set(rows.filter(r => r.severity !== "normal").map(r => r.po)).size,
      criticalPos: s.poCountBySeverity.critical,
      qty: rows.reduce((a, r) => a + (r.orderQty || 0), 0),
      byType: Object.fromEntries(s.types.map(t => [t.type, t.count])),
    });
  }
  return out;
}

/* The movers: which categories grew or shrank most since the previous point.
   Growth is what a management meeting asks about first. */
export function movers(series, limit = 5) {
  if (!series || series.length < 2) return [];
  const now = series[series.length - 1].byType;
  const prev = series[series.length - 2].byType;
  const keys = new Set([...Object.keys(now), ...Object.keys(prev)]);
  return [...keys]
    .map(type => ({
      type,
      label: NOTIFICATION_TYPES[type]?.label || type,
      category: NOTIFICATION_TYPES[type]?.category || "",
      now: now[type] || 0,
      prev: prev[type] || 0,
      delta: (now[type] || 0) - (prev[type] || 0),
    }))
    .filter(m => m.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, limit);
}
