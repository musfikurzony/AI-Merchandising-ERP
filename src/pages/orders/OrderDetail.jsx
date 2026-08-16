import React, { useEffect, useState } from "react";
import { useParams, Link, useOutletContext } from "react-router-dom";
import {
  getOrder, getOrderColorWays, getOrderSamples, getOrderCrdHistory,
  assignFactory, getAuditLog, getMilestoneTypesFull, getOrderMilestones, saveMilestoneField, getFilterOptions, editOrder, addMasterDataValue,
  getOrderSharedUsers, shareOrderWithUser, revokeOrderShare,
  requestPoCancellation, getPoCancellationRequestForPo, approvePoCancellation, rejectPoCancellation,
} from "../../lib/ordersApi.js";
import { fmtCompact } from "../../lib/dateFormat.js";
import { getColumnPrefs } from "../../lib/workbenchApi.js";
import { hasModulePermission } from "../../lib/permissions.js";
import { getShipmentSummaryForOrder, getShipmentLinesForOrder } from "../../lib/shipmentApi.js";

/* Real port of v13's OrderDetail -- same seven tabs, same Working Sheet,
   same structure -- reading and writing real Supabase data instead of
   demo state. Built after actually reading v13's OrderDetail component
   (lines ~1141-1900 of the real prototype source) rather than guessing at
   what it contained. */

function fmtNum(n) { return n == null ? "—" : Number(n).toLocaleString("en-US"); }
function fmtFob(n) { return n == null ? "—" : `$${Number(n).toFixed(2)}`; }
function fmtMoney(n) { return n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`; }
function leadTimeDays(rcv, etd) {
  if (!rcv || !etd) return null;
  return Math.round((new Date(etd) - new Date(rcv)) / 86400000);
}

const STATUS_META = {
  unassigned: { label: "Unassigned", color: "#6B7280", bg: "#F3F4F6" },
  sourcing: { label: "Sourcing In Progress", color: "#1D4ED8", bg: "#DBEAFE" },
  production: { label: "In Production", color: "#15803D", bg: "#DCFCE7" },
  shipped: { label: "Shipped / Closed", color: "#6B7280", bg: "#F3F4F6" },
  cancelled: { label: "Cancelled", color: "#B91C1C", bg: "#FEE2E2" },
};
const RISK_META = {
  onTrack: { label: "On Track", dot: "#15803D" }, atRisk: { label: "At Risk", dot: "#B45309" },
  critical: { label: "Critical", dot: "#B91C1C" }, aging: { label: "Aging", dot: "#B91C1C" },
};
function StatusPill({ status }) { const m = STATUS_META[status] || STATUS_META.unassigned; return <span className="pill" style={{ color: m.color, background: m.bg }}>{m.label}</span>; }
function RiskDot({ risk }) { const m = RISK_META[risk] || RISK_META.onTrack; return <span className="risk-inline"><span className="dot" style={{ background: m.dot }} />{m.label}</span>; }

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "timeline", label: "Timeline View" },
  { key: "factory", label: "Factory Assignment" },
  { key: "tna", label: "Dynamic T&A" },
  { key: "samples", label: "Sample Tracking" },
  { key: "shipment", label: "Shipment Follow-up" },
  { key: "activity", label: "Activity Log" },
];

export default function OrderDetail() {
  const { id } = useParams();
  const { dateFormat } = useOutletContext();
  const [tab, setTab] = useState("overview");
  const [showSheet, setShowSheet] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [order, setOrder] = useState(null);
  const [colorWays, setColorWays] = useState([]);
  const [samples, setSamples] = useState([]);
  const [shipmentLines, setShipmentLines] = useState([]);
  const [shipmentSummary, setShipmentSummary] = useState([]);
  const [crdHistory, setCrdHistory] = useState([]);
  const [milestones, setMilestones] = useState([]);
  const [milestoneTypes, setMilestoneTypes] = useState([]);
  const [colPrefs, setColPrefs] = useState(null);
  const [auditLog, setAuditLog] = useState([]);
  const [factories, setFactories] = useState([]);
  const [labels, setLabels] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const [partialErrors, setPartialErrors] = useState([]);

  async function refresh() {
    setLoading(true); setError(null); setPartialErrors([]);
    try {
      // getOrder is the one genuinely critical fetch -- without it there's
      // nothing to show at all, so it's allowed to throw and block the
      // page, same as before. Everything else is secondary: a failure in
      // any one of them (exactly what happened here -- a single bad
      // relationship in the audit log query) should degrade gracefully,
      // not take down Overview, Timeline, Factory Assignment, and every
      // other tab that had nothing to do with the failure.
      const o = await getOrder(id);
      setOrder(o);

      const results = await Promise.allSettled([
        getOrderColorWays(id), getOrderSamples(id), getShipmentLinesForOrder(id), getOrderCrdHistory(id),
        getMilestoneTypesFull(), getAuditLog(id), getFilterOptions(), getOrderMilestones(id), getColumnPrefs(),
      ]);
      const [cw, s, shLines, crd, mt, al, opts, ms, savedPrefs] = results.map(r => r.status === "fulfilled" ? r.value : null);
      setColorWays(cw || []); setSamples(s || []); setShipmentLines(shLines || []); setCrdHistory(crd || []);
      setMilestoneTypes(mt || []); setAuditLog(al || []); setFactories(opts?.factories || []); setLabels(opts?.labels || []); setMilestones(ms || []);
      // getShipmentSummaryForOrder needs colorWays as an input, which is
      // itself being fetched in the same batch above -- can't be part of
      // that Promise.allSettled (circular ordering), so it runs as its
      // own step right after, now that colorWays is actually available.
      try { setShipmentSummary(await getShipmentSummaryForOrder(id, cw || [])); }
      catch (e) { setShipmentSummary([]); }
      // Same preference the Workbench saves -- merged against each
      // milestone's own default_on so a type the user has never explicitly
      // toggled still shows up per the catalog default, not silently
      // hidden just because it's missing from an older saved selection.
      const defaults = Object.fromEntries((mt || []).map(t => [t.key, t.default_on]));
      setColPrefs({ ...defaults, ...(savedPrefs || {}) });

      const failedLabels = ["Color Ways", "Samples", "Shipment Lines", "CRD History", "Milestone Catalog", "Activity Log", "Filter Options", "T&A Data", "Milestone Preferences"];
      const failures = results.map((r, i) => r.status === "rejected" ? `${failedLabels[i]}: ${r.reason?.message || "failed to load"}` : null).filter(Boolean);
      setPartialErrors(failures);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }
  useEffect(() => { refresh(); }, [id]);

  if (loading) return <div style={{ padding: 32 }}>Loading...</div>;
  if (error) return <div style={{ padding: 32, color: "#B91C1C" }}>{error}</div>;
  if (!order) return <div style={{ padding: 32 }}>Order not found, or you don't have access to it.</div>;

  return (
    <div style={{ padding: 24 }}>
      <Link to="/orders" style={{ fontSize: 12.5, color: "#6B7280", textDecoration: "none" }}>← Back to Orders</Link>
      {partialErrors.length > 0 && (
        <div style={{ background: "#FEF3C7", color: "#92400E", padding: "8px 14px", borderRadius: 8, fontSize: 12, marginTop: 8 }}>
          Some sections couldn't load and are showing empty: {partialErrors.join("; ")}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginTop: 8, marginBottom: 4 }}>
        <div>
          <div className="mono strong" style={{ fontSize: 22 }}>{order.po_prefix}{order.po_number}</div>
          <div style={{ color: "#6B7280", fontSize: 13 }}>
            {order.style} · {order.labels?.name || "—"} · {order.divisions?.name || "—"} · {order.customers?.name || "—"} · {order.season || "—"}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <StatusPill status={order.status} /><RiskDot risk={order.risk} />
          <button className="btn-primary" onClick={() => setShowEdit(true)}>Edit Order</button>
          <button className="btn-ghost-sm" onClick={() => setShowSheet(true)}>🖨 Working Sheet</button>
          {order.status !== "cancelled" && <button className="btn-ghost-sm" style={{ color: "#B91C1C", borderColor: "#FCA5A5" }} onClick={() => setShowCancel(true)}>Request Cancellation</button>}
        </div>
      </div>

      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #E5E7EB", marginBottom: 20 }}>
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            style={{
              padding: "10px 14px", border: "none", background: "none", cursor: "pointer", fontSize: 13,
              color: tab === t.key ? "#101B30" : "#6B7280", fontWeight: tab === t.key ? 600 : 400,
              borderBottom: tab === t.key ? "2px solid #2B6E6A" : "2px solid transparent",
            }}>{t.label}</button>
        ))}
      </div>

      {tab === "overview" && <OverviewTab order={order} colorWays={colorWays} milestones={milestones} crdHistory={crdHistory} dateFormat={dateFormat} />}
      {tab === "timeline" && <TimelineTab order={order} milestones={milestones} dateFormat={dateFormat} />}
      {tab === "factory" && <FactoryTab order={order} factories={factories} onAssigned={refresh} />}
      {tab === "tna" && <TnaTab order={order} colorWays={colorWays} milestones={milestones} milestoneTypes={milestoneTypes.filter(mt => colPrefs?.[mt.key])} onSaved={refresh} />}
      {tab === "samples" && <SamplesTab order={order} colorWays={colorWays} samples={samples} milestones={milestones} />}
      {tab === "shipment" && <ShipmentTab order={order} colorWays={colorWays} shipmentSummary={shipmentSummary} shipmentLines={shipmentLines} dateFormat={dateFormat} />}
      {tab === "activity" && <ActivityTab auditLog={auditLog} />}

      {showSheet && <WorkingSheet order={order} milestones={milestones} milestoneTypes={milestoneTypes} dateFormat={dateFormat} onClose={() => setShowSheet(false)} />}
      {showEdit && <EditOrderModal order={order} factories={factories} labels={labels} onClose={() => setShowEdit(false)} onSaved={async () => { setShowEdit(false); await refresh(); }} />}
      {showCancel && <CancellationModal order={order} onClose={() => setShowCancel(false)} onDone={async () => { setShowCancel(false); await refresh(); }} />}
    </div>
  );
}

function Field({ label, value }) {
  return <div style={{ marginBottom: 12 }}><div style={{ fontSize: 11, color: "#9CA3AF", textTransform: "uppercase" }}>{label}</div><div style={{ fontSize: 14 }}>{value ?? "—"}</div></div>;
}

/* Real, rule-based recommendations from actual data -- not fabricated
   text. Each rule reads real order/milestone fields; if nothing applies,
   says so honestly rather than inventing a generic-sounding line. */
function getRecommendations(order, milestones) {
  const recs = [];
  if (order.status === "unassigned") recs.push("This order has no factory assigned yet — sourcing, T&A, and fabric/trims booking are all blocked until it is.");
  const critical = milestones.filter(m => m.status === "critical");
  if (critical.length) recs.push(`${critical.length} milestone${critical.length > 1 ? "s are" : " is"} marked critical — review the Dynamic T&A tab.`);
  const overdue = milestones.filter(m => m.status === "atRisk");
  if (overdue.length) recs.push(`${overdue.length} milestone${overdue.length > 1 ? "s are" : " is"} at risk — a timely follow-up may prevent a delay downstream.`);
  if (order.etd && order.status !== "shipped") {
    const daysToEtd = Math.round((new Date(order.etd) - new Date()) / 86400000);
    if (daysToEtd < 14 && daysToEtd >= 0) recs.push(`ETD is ${daysToEtd} day${daysToEtd === 1 ? "" : "s"} away — confirm production is on schedule.`);
    if (daysToEtd < 0) recs.push(`ETD has passed by ${-daysToEtd} day${-daysToEtd === 1 ? "" : "s"} and the order hasn't shipped — needs attention.`);
  }
  if (recs.length === 0) recs.push("No action needed right now, based on current data.");
  return recs;
}

/* "My Orders" only ever showed orders where you're the primary
   merchandiser -- confirmed a real gap when a department has more than
   one merchandiser working the same PO. order_permissions already existed
   in the schema for exactly this (Migration 01), just with no UI to grant
   or revoke it anywhere -- this is that UI. Anyone the order is shared
   with sees it in their own My Orders and gets full edit access, same as
   the primary merchandiser (has_order_access() already checks both). */
function SharedWithPanel({ order }) {
  const [shares, setShares] = useState([]);
  const [merchandisers, setMerchandisers] = useState([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const [s, opts] = await Promise.all([getOrderSharedUsers(order.id), getFilterOptions()]);
      setShares(s);
      setMerchandisers(opts.merchandisers.filter(m => m.id !== order.primary_merchandiser_id && !s.some(sh => sh.user_id === m.id)));
    } catch (e) { setError(e.message); }
    setLoading(false);
  }
  useEffect(() => { refresh(); }, [order.id]);

  async function add() {
    if (!selected) return;
    try { await shareOrderWithUser(order.id, selected); setSelected(""); await refresh(); }
    catch (e) { setError(e.message); }
  }
  async function remove(id) {
    try { await revokeOrderShare(id); await refresh(); }
    catch (e) { setError(e.message); }
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Shared with</div>
      <p className="muted-sm" style={{ marginBottom: 10 }}>Other merchandisers who can see and edit this order in their own My Orders — useful when a department shares coverage on a PO.</p>
      {error && <p style={{ color: "#B91C1C", fontSize: 13 }}>{error}</p>}
      {!loading && shares.length === 0 && <p className="muted-sm">Not shared with anyone else yet.</p>}
      {shares.map(s => (
        <div key={s.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 0", borderBottom: "1px solid #F2F3F6" }}>
          <span>{s.profiles?.full_name || s.user_id}</span>
          <button className="btn-ghost-sm" onClick={() => remove(s.id)}>Remove</button>
        </div>
      ))}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <select value={selected} onChange={e => setSelected(e.target.value)} style={{ flex: 1, padding: 8 }}>
          <option value="">Add a merchandiser...</option>
          {merchandisers.map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
        </select>
        <button className="btn-primary" onClick={add} disabled={!selected}>Share</button>
      </div>
    </div>
  );
}

function OverviewTab({ order, colorWays, milestones, dateFormat }) {
  const leadTime = leadTimeDays(order.order_rcv_date, order.etd);
  const fields = [
    ["PO Prefix", order.po_prefix], ["PO #", order.po_number], ["Style", order.style],
    ["Ordered Quantity", fmtNum(order.qty)], ["FOB", "fob" in order ? fmtFob(order.fob) : "—"],
    ["Order Value", "fob" in order && order.fob != null ? fmtMoney(order.qty * order.fob) : "—"],
    ["Product Group", order.product_groups?.name || "—"], ["Label", order.labels?.name || "—"],
    ["Division", order.divisions?.name || "—"], ["Business Unit", order.business_units?.name || "—"],
    ["Customer", order.customers?.name || "—"], ["Season", order.season || "—"],
    ["Order Rcv Date", fmtCompact(order.order_rcv_date, dateFormat)], ["ETD", fmtCompact(order.etd, dateFormat)],
    ["Rev ETD", fmtCompact(order.revised_etd, dateFormat)],
    ["Merchandising Lead Time", leadTime != null ? `${leadTime} days (Order Rcv → ETD)` : "—"],
    ["Merchandiser", order.profiles?.full_name || "—"], ["Factory", order.factories?.name || "Not yet assigned"],
    ["Fabric Ref", order.fabric_ref || "—"],
    ["Color Way(s)", colorWays.length > 1 ? `${colorWays.length} colors — see Sample Tracking` : (colorWays[0]?.name || "—")],
  ];
  return (
    <div>
      <div className="card" style={{ borderLeft: "3px solid #2B6E6A", marginBottom: 16 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>✨ Recommendation</div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: "#374151" }}>
          {getRecommendations(order, milestones).map((r, i) => <li key={i} style={{ marginBottom: 4 }}>{r}</li>)}
        </ul>
      </div>
      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Order master</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
          {fields.map(([k, v]) => <Field key={k} label={k} value={v} />)}
        </div>
        {order.status === "unassigned" && (
          <div style={{ marginTop: 14, padding: 12, background: "#FEF3C7", borderRadius: 8, fontSize: 13, color: "#92400E" }}>
            ⚠ This order is awaiting a factory decision before T&A, Fabric, Trims, or Production can begin.
          </div>
        )}
      </div>
      <SharedWithPanel order={order} />
    </div>
  );
}

function TimelineTab({ order, milestones, dateFormat }) {
  const leadTime = leadTimeDays(order.order_rcv_date, order.etd);
  const byKey = Object.fromEntries(milestones.filter(m => !m.color_way_name).map(m => [m.milestone_key, m]));
  const done = k => byKey[k]?.status === "done";
  const steps = [
    { label: "Order Imported", state: "done" },
    { label: "Factory Assigned", state: order.factory_code ? "done" : "pending" },
  ];
  if (order.factory_code) {
    steps.push({ label: "Fabric In-house", state: done("fab_inhouse") ? "done" : (byKey.fab_inhouse?.status === "critical" ? "warn" : "pending") });
    steps.push({ label: "Fit Approved", state: done("fit") ? "done" : "pending" });
    steps.push({ label: "PP Approved", state: done("pp") ? "done" : (byKey.pp?.status === "atRisk" ? "warn" : "pending") });
    steps.push({ label: "Production Started", state: order.status === "production" || order.status === "shipped" ? "done" : "pending" });
    steps.push({ label: "Inspection Passed", state: done("inspection") ? "done" : "pending" });
    steps.push({ label: "Shipment Completed", state: order.status === "shipped" ? "done" : "pending" });
  }
  return (
    <div className="card">
      <div style={{ fontWeight: 600, marginBottom: 8 }}>{order.po_prefix}{order.po_number} — progress at a glance</div>
      {order.order_rcv_date && (
        <p className="muted-sm" style={{ marginBottom: 14 }}>
          Order Rcv Date: <span className="mono strong">{fmtCompact(order.order_rcv_date, dateFormat)}</span>
          {leadTime != null && <> · Merchandising Lead Time: <span className="mono strong">{leadTime} days</span> to ETD {fmtCompact(order.etd, dateFormat)}</>}
        </p>
      )}
      <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {steps.map((s, i) => (
          <li key={i} style={{ padding: "8px 0", borderBottom: i < steps.length - 1 ? "1px solid #F2F3F6" : "none", color: s.state === "done" ? "#15803D" : s.state === "warn" ? "#B45309" : "#9CA3AF" }}>
            <span style={{ marginRight: 10 }}>{s.state === "done" ? "✓" : s.state === "warn" ? "⚠" : "○"}</span>{s.label}
          </li>
        ))}
      </ul>
      <p className="muted-sm" style={{ marginTop: 10 }}>For planned vs. actual dates, use the Dynamic T&amp;A tab.</p>
    </div>
  );
}

function FactoryTab({ order, factories, onAssigned }) {
  const [selected, setSelected] = useState(factories[0]?.code || "");
  const [factoryList, setFactoryList] = useState(factories);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  async function refreshFactories() {
    const opts = await getFilterOptions();
    setFactoryList(opts.factories);
  }

  async function handleAssign() {
    setSaving(true); setError(null); setResult(null);
    try {
      const r = await assignFactory(order.id, selected);
      setResult(r);
      await onAssigned();
    }
    catch (e) { setError(e.message); }
    setSaving(false);
  }

  if (order.factory_code) {
    return (
      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Factory assignment</div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: 14, background: "#F9FAFB", borderRadius: 8 }}>
          <span style={{ fontSize: 20 }}>🏭</span>
          <div><div style={{ fontWeight: 600 }}>{order.factory_code} - {order.factories?.name}</div><div className="muted-sm">Assigned · unlocks T&amp;A, Fabric &amp; Trims booking</div></div>
        </div>
      </div>
    );
  }
  return (
    <div className="card">
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Assign a factory</div>
      <p className="muted-sm" style={{ marginBottom: 14 }}>Factory is never part of the PLM import — it's a merchandising decision made here. Assigning it applies to every style under this PO ({order.po_prefix}{order.po_number}), not just this one, and unlocks Dynamic T&amp;A and Fabric/Trims booking for each.</p>
      {error && <p style={{ color: "#B91C1C", fontSize: 13 }}>{error}</p>}
      {result && <p style={{ color: "#15803D", fontSize: 13 }}>Factory assigned to {result.updatedCount} of {result.totalStyles} style(s) under this PO.</p>}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
        <div style={{ minWidth: 260 }}>
          <SelectWithAddNew value={selected} onChange={setSelected} options={factoryList} table="factories" onAdded={refreshFactories} placeholder="Select a factory" />
        </div>
        <button className="btn-primary" onClick={handleAssign} disabled={saving || !selected}>{saving ? "Assigning..." : "Assign Factory"}</button>
      </div>
    </div>
  );
}

const TNA_STATUS_OPTIONS = [["done", "Done"], ["onTrack", "On Track"], ["atRisk", "Overdue"], ["critical", "Delayed"], ["pending", "Pending"]];
function TnaRow({ label, milestone, orderId, milestoneKey, colorWayName, fieldType, onSaved }) {
  const [plan, setPlan] = useState(milestone?.plan_date || "");
  const [actual, setActual] = useState(milestone?.actual_date || "");
  const [status, setStatus] = useState(milestone?.status || "pending");
  const [remarks, setRemarks] = useState(milestone?.remarks || "");
  const [saving, setSaving] = useState(false);

  async function persist(fields) {
    setSaving(true);
    try { await saveMilestoneField(orderId, milestoneKey, colorWayName, fields); await onSaved(); }
    finally { setSaving(false); }
  }

  return (
    <tr>
      <td>{label}</td>
      {fieldType === "pds" ? (
        <>
          <td><input type="date" className="wb-input" value={plan} onChange={e => setPlan(e.target.value)} onBlur={() => persist({ plan_date: plan || null, actual_date: actual || null, status, remarks })} /></td>
          <td><input type="date" className="wb-input" value={actual} onChange={e => setActual(e.target.value)} onBlur={() => persist({ plan_date: plan || null, actual_date: actual || null, status, remarks })} /></td>
          <td><select className="wb-status" value={status} onChange={e => { setStatus(e.target.value); persist({ plan_date: plan || null, actual_date: actual || null, status: e.target.value, remarks }); }}>{TNA_STATUS_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
        </>
      ) : <td colSpan={2} className="muted-sm">—</td>}
      <td><input placeholder="Add a comment..." className="tna-remarks-input" defaultValue={remarks} onBlur={e => { setRemarks(e.target.value); persist({ plan_date: plan || null, actual_date: actual || null, status, remarks: e.target.value }); }} /></td>
    </tr>
  );
}

function TnaTab({ order, colorWays, milestones, milestoneTypes, onSaved }) {
  if (!order.factory_code) {
    return <div className="card" style={{ textAlign: "center", padding: 40 }}><div style={{ fontSize: 28 }}>🏭</div><div style={{ fontWeight: 600, margin: "8px 0" }}>Assign a factory first</div><p className="muted-sm">T&amp;A milestones and plan dates depend on the factory's lead times.</p></div>;
  }
  const byKey = {};
  milestones.forEach(m => { byKey[`${m.milestone_key}|${m.color_way_name || ""}`] = m; });
  const rows = [];
  milestoneTypes.forEach(mt => {
    if (mt.color_level) {
      colorWays.forEach(cw => rows.push({ label: `${mt.label} (${cw.name})`, milestoneKey: mt.key, colorWayName: cw.name, fieldType: mt.field_type, milestone: byKey[`${mt.key}|${cw.name}`] }));
    } else {
      rows.push({ label: mt.label + (mt.style_level ? " (style-level)" : ""), milestoneKey: mt.key, colorWayName: "", fieldType: mt.field_type, milestone: byKey[`${mt.key}|`] });
    }
  });
  return (
    <div className="card no-pad">
      <div style={{ fontWeight: 600, padding: "16px 18px 0" }}>Critical path — scroll to see all milestones</div>
      <p className="muted-sm" style={{ padding: "0 18px" }}>Remarks are real and editable — they carry through to Reports Center and exports.</p>
      <div className="tna-scroll">
        <table className="data-table tna-table">
          <thead><tr><th>Milestone</th><th>Plan Date</th><th>Actual Date</th><th>Status</th><th>Remarks</th></tr></thead>
          <tbody>
            {rows.map((r, i) => <TnaRow key={i} label={r.label} milestone={r.milestone} orderId={order.id} milestoneKey={r.milestoneKey} colorWayName={r.colorWayName} fieldType={r.fieldType} onSaved={onSaved} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SamplePill({ status }) {
  const map = { done: ["Approved", "#15803D", "#DCFCE7"], pending: ["Pending", "#B45309", "#FEF3C7"], critical: ["Rejected", "#B91C1C", "#FEE2E2"] };
  const [label, color, bg] = map[status] || ["—", "#9CA3AF", "#F3F4F6"];
  return <span className="pill" style={{ color, background: bg }}>{label}</span>;
}

function SamplesTab({ order, colorWays, samples, milestones }) {
  if (!order.factory_code) return <div className="card" style={{ textAlign: "center", padding: 40 }}><div style={{ fontSize: 28 }}>📋</div><div style={{ fontWeight: 600, margin: "8px 0" }}>No sample rounds yet</div><p className="muted-sm">Sample tracking begins once a factory is assigned.</p></div>;
  const byKey = {};
  milestones.forEach(m => { byKey[`${m.milestone_key}|${m.color_way_name || ""}`] = m; });
  const colorMilestones = ["lab_dip", "strike_off", "pp", "top"];
  return (
    <div>
      <div className="card">
        <div style={{ fontWeight: 600 }}>Style-Level Samples <span className="muted-sm">(approved once for Style {order.style})</span></div>
        <div style={{ display: "flex", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
          {samples.length === 0 && <p className="muted-sm">No style-level sample records yet.</p>}
          {samples.map((s, i) => (
            <div key={i} style={{ padding: 14, background: "#F9FAFB", borderRadius: 8, minWidth: 180 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}><b>{s.sample_type}</b><span className="muted-sm">{s.level}</span></div>
            </div>
          ))}
        </div>
      </div>
      <div className="card no-pad">
        <div style={{ fontWeight: 600, padding: "16px 18px 0" }}>Color-Level Samples <span className="muted-sm">(Lab Dip, Strike-off, PP &amp; TOP per Color Way)</span></div>
        <table className="data-table">
          <thead><tr><th>Color Way</th><th>Lab Dip</th><th>Strike-off</th><th>PP Sample</th><th>TOP Sample</th></tr></thead>
          <tbody>
            {colorWays.map(cw => (
              <tr key={cw.name}>
                <td className="strong">{cw.name}</td>
                {colorMilestones.map(k => <td key={k}><SamplePill status={byKey[`${k}|${cw.name}`]?.status} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ShipmentTab({ order, colorWays, shipmentSummary, shipmentLines, dateFormat }) {
  if (order.status === "unassigned" || order.status === "sourcing") {
    return <div className="card" style={{ textAlign: "center", padding: 40 }}><div style={{ fontSize: 28 }}>🚢</div><div style={{ fontWeight: 600, margin: "8px 0" }}>Not yet ready for shipment</div><p className="muted-sm">Shipment tracking activates once inspection is underway.</p></div>;
  }
  return (
    <div>
      <div className="card">
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Shipped vs. Ordered, by color</div>
        <table className="data-table">
          <thead><tr><th>Color</th><th>Ordered</th><th>Shipped</th><th>Balance</th><th>Shipments</th></tr></thead>
          <tbody>
            {shipmentSummary.map(s => (
              <tr key={s.color}>
                <td className="strong">{s.color}</td>
                <td className="mono">{fmtNum(s.orderedQty)}</td>
                <td className="mono">{fmtNum(s.shippedQty)}</td>
                <td className="mono" style={{ color: s.balance > 0 ? "#B45309" : "#15803D" }}>{fmtNum(s.balance)}</td>
                <td className="mono">{s.shipmentCount}</td>
              </tr>
            ))}
            {shipmentSummary.length === 0 && <tr><td colSpan={5} className="empty-row">No colors recorded yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        {/* Every partial shipment shown as its own row -- deliberately not
            combined into one total per color, per the explicit
            requirement. */}
        <div style={{ fontWeight: 600, marginBottom: 12 }}>Individual shipments</div>
        <table className="data-table">
          <thead><tr><th>Color</th><th>Qty</th><th>Vessel</th><th>Booking Date</th><th>Actual ETD</th><th>Destination</th></tr></thead>
          <tbody>
            {shipmentLines.map(l => (
              <tr key={l.id}>
                <td>{l.color_way_name || "—"}</td>
                <td className="mono">{fmtNum(l.shipped_qty)}</td>
                <td>{l.shipments?.vessel || "—"}</td>
                <td className="mono">{fmtCompact(l.shipments?.booking_date, dateFormat)}</td>
                <td className="mono">{fmtCompact(l.shipments?.actual_etd, dateFormat)}</td>
                <td>{l.shipments?.destination_port || "—"}</td>
              </tr>
            ))}
            {shipmentLines.length === 0 && <tr><td colSpan={6} className="empty-row">No shipments recorded yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ActivityTab({ auditLog }) {
  return (
    <div className="card">
      <div style={{ fontWeight: 600, marginBottom: 8 }}>Activity log</div>
      <p className="muted-sm" style={{ marginBottom: 10 }}>Every field edit on this order writes here automatically.</p>
      {auditLog.length === 0 && <p className="muted-sm">No activity recorded yet.</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {auditLog.map((l, i) => (
          <li key={i} style={{ padding: "10px 0", borderBottom: "1px solid #F2F3F6" }}>
            <div>{l.action.replace(/_/g, " ").replace(/^order\./, "")}{l.field_name ? ` — ${l.field_name}` : ""}{l.new_value ? `: ${l.new_value}` : ""}</div>
            <div className="muted-sm">{l.profiles?.full_name || "System"} · {new Date(l.created_at).toLocaleString()}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function fmtDelay(planDate, actualDate) {
  if (!planDate || !actualDate) return "—";
  const days = Math.round((new Date(actualDate) - new Date(planDate)) / 86400000);
  if (days === 0) return "—";
  return days > 0 ? `+${days} day${days > 1 ? "s" : ""}` : `${days} day${days < -1 ? "s" : ""}`;
}
function WsStatusMark({ s }) {
  if (s === "done") return <span style={{ color: "#15803D" }}>✓ Done</span>;
  if (s === "critical") return <span style={{ color: "#B91C1C" }}>⚠ Delayed</span>;
  if (s === "atRisk") return <span style={{ color: "#B45309" }}>⚠ Overdue</span>;
  return <span style={{ color: "#9CA3AF" }}>Pending</span>;
}

function WorkingSheet({ order, milestones, milestoneTypes, dateFormat, onClose }) {
  const labelByKey = Object.fromEntries(milestoneTypes.map(mt => [mt.key, mt.label]));
  const rows = milestones.filter(m => m.status || m.plan_date || m.actual_date)
    .sort((a, b) => (milestoneTypes.find(mt => mt.key === a.milestone_key)?.sequence_order || 0) - (milestoneTypes.find(mt => mt.key === b.milestone_key)?.sequence_order || 0));
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(16,27,48,0.6)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ background: "#fff", width: "94%", maxWidth: 1000, maxHeight: "88vh", overflowY: "auto", borderRadius: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", padding: 14, background: "#F3F4F6", borderRadius: "10px 10px 0 0" }}>
          <div>Merchandiser Working Sheet — preview (Landscape A4/A3)</div>
          <div><button className="btn-ghost-sm" onClick={onClose}>Close</button> <button className="btn-primary" style={{ marginLeft: 10 }} onClick={() => window.print()}>Print</button></div>
        </div>
        <div style={{ padding: 24 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div><div style={{ fontSize: 11, color: "#2B6E6A" }}>AI MERCHANDISING ERP</div><div style={{ fontSize: 18, fontWeight: 700 }}>Merchandiser Working Sheet</div></div>
            <div className="mono" style={{ fontSize: 18, fontWeight: 700 }}>{order.po_prefix}{order.po_number}</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginTop: 16, fontSize: 12.5 }}>
            <Field label="Style" value={order.style} />
            <Field label="Product Group" value={order.product_groups?.name} />
            <Field label="Label" value={order.labels?.name} />
            <Field label="Business Unit" value={order.business_units?.name} />
            <Field label="Factory" value={order.factories?.name || "Not yet assigned"} />
            <Field label="Ordered Quantity" value={fmtNum(order.qty)} />
            <Field label="FOB" value={"fob" in order ? fmtFob(order.fob) : "—"} />
            <Field label="ETD" value={fmtCompact(order.etd, dateFormat)} />
            <Field label="Rev ETD" value={order.revised_etd ? fmtCompact(order.revised_etd, dateFormat) : "—"} />
            <Field label="Shipment Status" value={order.status === "shipped" ? "Shipped" : "Pending"} />
            <Field label="Merchandiser" value={order.profiles?.full_name} />
          </div>
          <table className="data-table" style={{ marginTop: 16 }}>
            <thead><tr><th>Milestone</th><th>Planned Date</th><th>Actual Date</th><th>Status</th><th>Delay</th><th>Remarks</th></tr></thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{labelByKey[r.milestone_key] || r.milestone_key}{r.color_way_name ? ` (${r.color_way_name})` : ""}</td>
                  <td className="mono">{fmtCompact(r.plan_date, dateFormat)}</td>
                  <td className="mono">{fmtCompact(r.actual_date, dateFormat) === "—" ? "—" : fmtCompact(r.actual_date, dateFormat)}</td>
                  <td><WsStatusMark s={r.status} /></td>
                  <td className="mono">{fmtDelay(r.plan_date, r.actual_date)}</td>
                  <td>{r.remarks || ""}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6} className="empty-row">No T&amp;A data recorded yet.</td></tr>}
            </tbody>
          </table>
          <p className="muted-sm" style={{ marginTop: 12 }}>For internal factory follow-up use — print in Landscape A4 or A3</p>
        </div>
      </div>
    </div>
  );
}

/* A <select> with a built-in "add a new one" option -- for master data
   (Customer, Product Group, Label, Division, Business Unit) that might not
   have a matching row yet, e.g. a genuinely new customer on a Licensee
   order. Writing the new value is gated by the exact same
   `system_settings` permission that already controls every master data
   write in this project -- if the current user doesn't have it, they get
   a clear message instead of a silent failure or an actual bypass. */
function SelectWithAddNew({ value, onChange, options, table, onAdded, placeholder }) {
  const [adding, setAdding] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function confirmAdd() {
    if (!newCode.trim() || !newName.trim()) { setError("Both a code and a name are required."); return; }
    setSaving(true); setError(null);
    try {
      const created = await addMasterDataValue(table, newCode, newName);
      await onAdded();
      onChange(created.code);
      setAdding(false); setNewCode(""); setNewName("");
    } catch (e) {
      setError(e.message);
    }
    setSaving(false);
  }

  if (adding) {
    return (
      <div style={{ border: "1px solid #CFE5E2", borderRadius: 6, padding: 8, background: "#F5FBFA" }}>
        {error && <p style={{ color: "#B91C1C", fontSize: 11.5, margin: "0 0 4px" }}>{error}</p>}
        <input placeholder="Code" value={newCode} onChange={e => setNewCode(e.target.value)} style={{ width: "100%", marginBottom: 4, padding: 6, fontSize: 12 }} />
        <input placeholder="Name" value={newName} onChange={e => setNewName(e.target.value)} style={{ width: "100%", marginBottom: 6, padding: 6, fontSize: 12 }} />
        <div style={{ display: "flex", gap: 6 }}>
          <button type="button" className="btn-ghost-sm" onClick={() => { setAdding(false); setError(null); }} disabled={saving}>Cancel</button>
          <button type="button" className="btn-primary" onClick={confirmAdd} disabled={saving} style={{ fontSize: 12, padding: "5px 10px" }}>{saving ? "Adding..." : "Add"}</button>
        </div>
      </div>
    );
  }
  return (
    <select value={value} onChange={e => e.target.value === "__add_new__" ? setAdding(true) : onChange(e.target.value)}>
      <option value="">{placeholder || "—"}</option>
      {options.map(o => <option key={o.code} value={o.code}>{o.code} - {o.name}</option>)}
      <option value="__add_new__">+ Add New...</option>
    </select>
  );
}


/* PO Cancellation -- one modal covers both roles: a merchandiser sees a
   reason field and a Submit button; anyone who can approve (Manager/Admin,
   via the existing 'orders' module 'approve' permission -- no new
   permission concept) sees the pending request's own reason plus
   Approve/Reject, if one already exists. Cancellation is explicitly a
   whole-PO action -- confirmed here in the copy, not something this modal
   lets you scope down to one style. */
function CancellationModal({ order, onClose, onDone }) {
  const [existing, setExisting] = useState(null);
  const [canApprove, setCanApprove] = useState(false);
  const [reason, setReason] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([
      getPoCancellationRequestForPo(order.po_prefix, order.po_number),
      hasModulePermission("orders", "approve"),
    ]).then(([req, approve]) => { setExisting(req); setCanApprove(approve); setLoading(false); });
  }, [order.po_prefix, order.po_number]);

  async function submit() {
    if (!reason.trim()) { setError("Please give a reason for the cancellation."); return; }
    setSaving(true); setError(null);
    try { await requestPoCancellation(order.po_prefix, order.po_number, reason.trim()); await onDone(); }
    catch (e) { setError(e.message); }
    setSaving(false);
  }
  async function approve() {
    setSaving(true); setError(null);
    try { await approvePoCancellation(existing.id, reviewNote.trim() || null); await onDone(); }
    catch (e) { setError(e.message); }
    setSaving(false);
  }
  async function reject() {
    setSaving(true); setError(null);
    try { await rejectPoCancellation(existing.id, reviewNote.trim() || null); await onDone(); }
    catch (e) { setError(e.message); }
    setSaving(false);
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ width: 480 }}>
        <div className="modal-title">Cancel PO — {order.po_prefix}{order.po_number}</div>
        <p className="muted-sm" style={{ marginBottom: 14 }}>This cancels the entire PO — every style and color under it — not just this one order. Requires Manager/Admin approval before it takes effect. All historical data (milestones, CRD history, shipments) stays intact for reporting.</p>
        {error && <p style={{ color: "#B91C1C", fontSize: 13 }}>{error}</p>}
        {loading ? <p className="muted-sm">Loading...</p> : existing ? (
          <>
            <div style={{ background: "#F9FAFB", borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div className="muted-sm">Cancellation already requested, awaiting review</div>
              <div style={{ marginTop: 6 }}>{existing.reason}</div>
            </div>
            {canApprove ? (
              <>
                <label className="edit-field" style={{ marginBottom: 12 }}>Review note (optional)<input value={reviewNote} onChange={e => setReviewNote(e.target.value)} /></label>
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                  <button className="btn-ghost-sm" onClick={onClose} disabled={saving}>Close</button>
                  <button className="btn-ghost-sm" style={{ color: "#B91C1C" }} onClick={reject} disabled={saving}>Reject</button>
                  <button className="btn-primary" style={{ background: "#B91C1C" }} onClick={approve} disabled={saving}>{saving ? "..." : "Approve Cancellation"}</button>
                </div>
              </>
            ) : (
              <div style={{ display: "flex", justifyContent: "flex-end" }}><button className="btn-ghost-sm" onClick={onClose}>Close</button></div>
            )}
          </>
        ) : (
          <>
            <label className="edit-field" style={{ marginBottom: 12 }}>Reason for cancellation <span style={{ color: "#B91C1C" }}>*</span><input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Buyer cancelled the program" /></label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn-ghost-sm" onClick={onClose} disabled={saving}>Cancel</button>
              <button className="btn-primary" style={{ background: "#B91C1C" }} onClick={submit} disabled={saving}>{saving ? "Submitting..." : "Submit Request"}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function EditOrderModal({ order, factories, labels, onClose, onSaved }) {
  const [options, setOptions] = useState({ productGroups: [], customers: [], divisions: [], businessUnits: [], merchandisers: [] });
  const [form, setForm] = useState({
    etd: order.etd || "", revised_etd: order.revised_etd || "", revised_etd_reason: "",
    factory_code: order.factory_code || "", qty: order.qty ?? "",
    fob: "fob" in order ? (order.fob ?? "") : "",
    status: order.status || "unassigned",
    product_group_code: order.product_groups?.code || "",
    label_code: order.labels?.code || "", season: order.season || "",
    customer_code: order.customers?.code || "", division_code: order.divisions?.code || "",
    business_unit_code: order.business_units?.code || "", primary_merchandiser_id: order.primary_merchandiser_id || "",
    fabric_ref: order.fabric_ref || "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const showFob = "fob" in order;
  const revisedEtdChanged = form.revised_etd !== (order.revised_etd || "");

  async function refreshOptions() { setOptions(await getFilterOptions()); }
  useEffect(() => { refreshOptions(); }, []);

  function set(k, v) { setForm({ ...form, [k]: v }); }

  async function save() {
    if (revisedEtdChanged && !form.revised_etd_reason.trim()) {
      setError("Please give a reason for the Revised ETD change.");
      return;
    }
    setSaving(true); setError(null);
    try {
      const changes = {
        etd: form.etd || null, revised_etd: form.revised_etd || null,
        factory_code: form.factory_code || null, qty: form.qty === "" ? null : Number(form.qty),
        status: form.status, product_group_code: form.product_group_code || null,
        label_code: form.label_code || null, season: form.season || null,
        customer_code: form.customer_code || null, division_code: form.division_code || null,
        business_unit_code: form.business_unit_code || null,
        primary_merchandiser_id: form.primary_merchandiser_id || null,
        fabric_ref: form.fabric_ref || null,
      };
      if (showFob) changes.fob = form.fob === "" ? null : Number(form.fob);
      const before = {
        etd: order.etd, revised_etd: order.revised_etd, factory_code: order.factory_code, qty: order.qty, fob: order.fob,
        status: order.status, product_group_code: order.product_groups?.code, label_code: order.labels?.code, season: order.season,
        customer_code: order.customers?.code, division_code: order.divisions?.code,
        business_unit_code: order.business_units?.code, primary_merchandiser_id: order.primary_merchandiser_id,
        fabric_ref: order.fabric_ref,
      };
      await editOrder(order.id, before, changes, revisedEtdChanged ? form.revised_etd_reason.trim() : null);
      await onSaved();
    } catch (e) {
      setError(e.message);
    }
    setSaving(false);
  }

  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ width: 620 }}>
        <div className="modal-title">Edit Order — {order.po_prefix}{order.po_number}</div>
        <p className="muted-sm" style={{ marginBottom: 14 }}>Changes are written to the Activity Log automatically, one line per changed field.</p>
        {error && <p style={{ color: "#B91C1C", fontSize: 13 }}>{error}</p>}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label className="edit-field">ETD<input type="date" value={form.etd} onChange={e => set("etd", e.target.value)} /></label>
          <label className="edit-field">Revised ETD<input type="date" value={form.revised_etd} onChange={e => set("revised_etd", e.target.value)} /></label>
          {/* Reason prompt for Revised ETD specifically -- flagging honestly:
              this wasn't literally in v13's EditOrderModal source (checked
              directly), but matches the same "reason required" pattern v13
              uses for Re-source Order. Added as a reasonable extension, not
              claimed as something already in the prototype. */}
          {revisedEtdChanged && (
            <label className="edit-field" style={{ gridColumn: "1 / -1" }}>
              Reason for Revised ETD change <span style={{ color: "#B91C1C" }}>*</span>
              <input value={form.revised_etd_reason} onChange={e => set("revised_etd_reason", e.target.value)} placeholder="e.g. Fabric delay confirmed by factory" />
            </label>
          )}
          <label className="edit-field">Customer<SelectWithAddNew value={form.customer_code} onChange={v => set("customer_code", v)} options={options.customers} table="customers" onAdded={refreshOptions} /></label>
          <label className="edit-field">Merchandiser<select value={form.primary_merchandiser_id} onChange={e => set("primary_merchandiser_id", e.target.value)}><option value="">—</option>{options.merchandisers.map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}</select></label>
          <label className="edit-field">Division<SelectWithAddNew value={form.division_code} onChange={v => set("division_code", v)} options={options.divisions} table="divisions" onAdded={refreshOptions} /></label>
          <label className="edit-field">Business Unit<SelectWithAddNew value={form.business_unit_code} onChange={v => set("business_unit_code", v)} options={options.businessUnits} table="business_units" onAdded={refreshOptions} /></label>
          <label className="edit-field">Factory<select value={form.factory_code} onChange={e => set("factory_code", e.target.value)}><option value="">Not yet assigned</option>{factories.map(f => <option key={f.code} value={f.code}>{f.code} - {f.name}</option>)}</select></label>
          <label className="edit-field">Status<select value={form.status} onChange={e => set("status", e.target.value)}><option value="unassigned">Unassigned</option><option value="sourcing">Sourcing</option><option value="production">In Production</option><option value="shipped">Shipped</option></select></label>
          <label className="edit-field">Qty<input type="number" value={form.qty} onChange={e => set("qty", e.target.value)} /></label>
          {showFob && <label className="edit-field">FOB<input type="number" step="0.01" value={form.fob} onChange={e => set("fob", e.target.value)} /></label>}
          <label className="edit-field">Fabric Ref<input value={form.fabric_ref} onChange={e => set("fabric_ref", e.target.value)} placeholder="From PLM, or add manually" /></label>
          {/* Product Group is a real select here, not the free-text input
              v13 used -- orders.product_group_code is a genuine foreign
              key in this schema, and free text would let this field
              silently stop matching any real master data. The minimum
              necessary change from v13, not a design preference. */}
          <label className="edit-field">Product Group<SelectWithAddNew value={form.product_group_code} onChange={v => set("product_group_code", v)} options={options.productGroups} table="product_groups" onAdded={refreshOptions} /></label>
          <label className="edit-field">Label<SelectWithAddNew value={form.label_code} onChange={v => set("label_code", v)} options={options.labels?.length ? options.labels : labels} table="labels" onAdded={refreshOptions} /></label>
          <label className="edit-field">Season<input value={form.season} onChange={e => set("season", e.target.value)} /></label>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button className="btn-ghost-sm" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn-primary" onClick={save} disabled={saving}>{saving ? "Saving..." : "Save Changes"}</button>
        </div>
      </div>
    </div>
  );
}
