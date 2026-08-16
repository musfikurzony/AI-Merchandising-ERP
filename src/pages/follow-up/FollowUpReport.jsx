import React, { useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import * as XLSX from "xlsx";
import { getMilestoneTypes, listWorkbenchOrders, listColorWays, listMilestones, getFollowUpColumnPrefs, saveFollowUpColumnPrefs } from "../../lib/workbenchApi.js";
import { fmtCompact } from "../../lib/dateFormat.js";

/* Real port of v13's actual FollowupReport (confirmed against the real
   source, not the milestone-description guess this replaced): grouped by
   Label, one row per color way, sharing the exact same milestone spec
   (tna_milestone_types / order_milestones) the Workbench uses -- so a
   value entered in either place shows up in both, immediately. The
   printed report uses a leaner default column set than the Workbench
   (confirmed via v13's own REPORT_DEFAULT_KEYS), persisted separately per
   user. Only orders with a factory assigned are shown -- same rule v13
   uses, and the same one `listWorkbenchOrders()` already enforces. */

const REPORT_DEFAULT_KEYS = ["fab_ref", "lab_dip", "strike_off", "fab_etd", "fab_inhouse", "fit", "pp", "prod_start", "shade_band", "crd"];

function fmtNum(n) { return n == null ? "—" : Number(n).toLocaleString("en-US"); }

function buildColorRows(orders, colorWaysByOrder) {
  const rows = [];
  orders.forEach(o => {
    const colors = colorWaysByOrder[o.id]?.length ? colorWaysByOrder[o.id] : [{ name: "—", qty: o.qty }];
    colors.forEach((cw, idx) => rows.push({ rowId: `${o.id}-c${idx}`, order: o, colorName: cw.name, colorQty: cw.qty ?? o.qty }));
  });
  return rows;
}

function groupByLabel(rows) {
  const groups = new Map();
  const order = [];
  rows.forEach(r => {
    const code = r.order.labels?.code || "—";
    if (!groups.has(code)) { groups.set(code, { label: r.order.labels, rows: [] }); order.push(code); }
    groups.get(code).rows.push(r);
  });
  return order.map(code => groups.get(code));
}

function milestoneCellText(row, col, milestonesByKey, dateFormat) {
  const key = `${row.order.id}|${col.key}|${col.color_level ? row.colorName : ""}`;
  const m = milestonesByKey[key];
  if (!m) return "—";
  if (col.field_type === "pds") {
    const dateVal = m.actual_date || m.plan_date;
    return dateVal ? `${fmtCompact(dateVal, dateFormat)} (${m.status || "pending"})` : (m.status || "—");
  }
  if (col.field_type === "text") return m.text_value || "—";
  if (col.field_type === "single") return m.single_value ? fmtCompact(m.single_value, dateFormat) : "—";
  return m.status || "—";
}

function ReportTable({ group, cols, milestonesByKey, dateFormat }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ background: "#101B30", color: "#fff", padding: "8px 14px", borderRadius: "8px 8px 0 0", fontWeight: 600, fontSize: 13 }}>
        {group.label ? `${group.label.code} - ${group.label.name}` : "No Label"}
      </div>
      <div className="tna-scroll">
        <table className="data-table" style={{ minWidth: 1200 }}>
          <thead>
            <tr>
              <th>BU</th><th>PO</th><th>Style</th><th>Color</th><th>Qty</th><th>FOB</th><th>ETD</th><th>Rev ETD</th>
              {cols.map(col => <th key={col.key}>{col.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {group.rows.map(row => (
              <tr key={row.rowId}>
                <td>{row.order.business_units?.code || "—"}</td>
                <td className="mono strong">{row.order.po_prefix}{row.order.po_number}</td>
                <td className="mono">{row.order.style}</td>
                <td className="mono">{row.colorName}</td>
                <td className="mono">{fmtNum(row.colorQty)}</td>
                <td className="mono">{"fob" in row.order && row.order.fob != null ? `$${Number(row.order.fob).toFixed(2)}` : "—"}</td>
                <td className="mono">{fmtCompact(row.order.etd, dateFormat)}</td>
                <td className="mono">{row.order.revised_etd ? fmtCompact(row.order.revised_etd, dateFormat) : "—"}</td>
                {cols.map(col => <td key={col.key}>{milestoneCellText(row, col, milestonesByKey, dateFormat)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ColumnSettingsButton({ milestoneTypes, colPrefs, setColPrefs, onPersist }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  async function done() {
    setSaving(true);
    try { await onPersist(colPrefs); } catch (e) { /* selection still applies this session even if the save failed */ }
    setSaving(false); setOpen(false);
  }
  return (
    <div style={{ position: "relative" }}>
      <button className="btn-ghost-sm" onClick={() => setOpen(!open)}>Columns</button>
      {open && (
        <div className="col-settings-panel">
          <div className="col-settings-title">Choose milestones to show</div>
          {milestoneTypes.map(col => (
            <label key={col.key} className="col-settings-row">
              <input type="checkbox" checked={!!colPrefs[col.key]} onChange={e => setColPrefs({ ...colPrefs, [col.key]: e.target.checked })} />
              {col.label}
            </label>
          ))}
          <button className="btn-primary" style={{ marginTop: 10, width: "100%" }} onClick={done} disabled={saving}>{saving ? "Saving..." : "Done"}</button>
        </div>
      )}
    </div>
  );
}

export default function FollowUpReport() {
  const { dateFormat } = useOutletContext();
  const [milestoneTypes, setMilestoneTypes] = useState([]);
  const [orders, setOrders] = useState([]);
  const [colorWaysByOrder, setColorWaysByOrder] = useState({});
  const [milestonesByKey, setMilestonesByKey] = useState({});
  const [colPrefs, setColPrefs] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showPrint, setShowPrint] = useState(false);

  const [filters, setFilters] = useState({ factoryCode: "all", merchandiser: "all", productGroup: "all", customerCode: "all", etdFrom: "", etdTo: "" });

  useEffect(() => {
    setLoading(true); setError(null);
    Promise.all([getMilestoneTypes(), listWorkbenchOrders(), getFollowUpColumnPrefs()])
      .then(async ([types, ords, savedPrefs]) => {
        setMilestoneTypes(types);
        const defaults = Object.fromEntries(types.map(t => [t.key, REPORT_DEFAULT_KEYS.includes(t.key)]));
        setColPrefs({ ...defaults, ...(savedPrefs || {}) });
        setOrders(ords);
        const orderIds = ords.map(o => o.id);
        const [cws, ms] = await Promise.all([listColorWays(orderIds), listMilestones(orderIds)]);
        const cwMap = {};
        cws.forEach(cw => { (cwMap[cw.order_id] = cwMap[cw.order_id] || []).push(cw); });
        setColorWaysByOrder(cwMap);
        const msMap = {};
        ms.forEach(m => { msMap[`${m.order_id}|${m.milestone_key}|${m.color_way_name || ""}`] = m; });
        setMilestonesByKey(msMap);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const factories = [...new Set(orders.map(o => o.factories?.name).filter(Boolean))];
  const merchandisers = [...new Set(orders.map(o => o.profiles?.full_name).filter(Boolean))];
  const productGroups = [...new Set(orders.map(o => o.product_groups?.name).filter(Boolean))];
  const customers = [...new Set(orders.map(o => o.customers?.name).filter(Boolean))];

  const filteredOrders = orders.filter(o =>
    (filters.factoryCode === "all" || o.factories?.name === filters.factoryCode) &&
    (filters.merchandiser === "all" || o.profiles?.full_name === filters.merchandiser) &&
    (filters.productGroup === "all" || o.product_groups?.name === filters.productGroup) &&
    (filters.customerCode === "all" || o.customers?.name === filters.customerCode) &&
    (!filters.etdFrom || !o.etd || o.etd >= filters.etdFrom) &&
    (!filters.etdTo || !o.etd || o.etd <= filters.etdTo)
  );

  const rows = useMemo(() => buildColorRows(filteredOrders, colorWaysByOrder), [filteredOrders, colorWaysByOrder]);
  const cols = milestoneTypes.filter(c => colPrefs[c.key]);
  const groups = useMemo(() => groupByLabel(rows), [rows]);

  function exportExcel() {
    const headers = ["Label", "BU", "PO", "Style", "Color", "Qty", "FOB", "ETD", "Rev ETD", ...cols.map(c => c.label)];
    const rowsOut = rows.map(r => [
      r.order.labels ? `${r.order.labels.code} - ${r.order.labels.name}` : "—",
      r.order.business_units?.code || "—", `${r.order.po_prefix}${r.order.po_number}`, r.order.style, r.colorName, r.colorQty,
      "fob" in r.order ? r.order.fob : "", r.order.etd, r.order.revised_etd || "",
      ...cols.map(c => milestoneCellText(r, c, milestonesByKey, dateFormat)),
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rowsOut]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Follow-up Report");
    XLSX.writeFile(wb, "Merchandising_Followup_Report.xlsx");
  }

  if (loading) return <div style={{ padding: 32 }}>Loading...</div>;

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginTop: 0 }}>Follow-up Report</h2>
      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}

      <div className="filter-row">
        <select value={filters.factoryCode} onChange={e => setFilters({ ...filters, factoryCode: e.target.value })}><option value="all">All Factories</option>{factories.map(f => <option key={f} value={f}>{f}</option>)}</select>
        <select value={filters.merchandiser} onChange={e => setFilters({ ...filters, merchandiser: e.target.value })}><option value="all">All Merchandisers</option>{merchandisers.map(m => <option key={m} value={m}>{m}</option>)}</select>
        <select value={filters.productGroup} onChange={e => setFilters({ ...filters, productGroup: e.target.value })}><option value="all">All Product Groups</option>{productGroups.map(p => <option key={p} value={p}>{p}</option>)}</select>
        <select value={filters.customerCode} onChange={e => setFilters({ ...filters, customerCode: e.target.value })}><option value="all">All Customers</option>{customers.map(c => <option key={c} value={c}>{c}</option>)}</select>
        <input type="date" value={filters.etdFrom} onChange={e => setFilters({ ...filters, etdFrom: e.target.value })} title="ETD from" />
        <span style={{ alignSelf: "center", color: "#9CA3AF" }}>to</span>
        <input type="date" value={filters.etdTo} onChange={e => setFilters({ ...filters, etdTo: e.target.value })} title="ETD to" />
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <ColumnSettingsButton milestoneTypes={milestoneTypes} colPrefs={colPrefs} setColPrefs={setColPrefs} onPersist={saveFollowUpColumnPrefs} />
          <button className="btn-ghost-sm" onClick={exportExcel}>Export to Excel</button>
          <button className="btn-primary" onClick={() => setShowPrint(true)}>Print Report</button>
        </div>
      </div>
      <p className="muted-sm" style={{ marginBottom: 14 }}>Grouped by Label — each section below is its own Label banner followed by that label's orders, one row per Color Way. Use Columns to add back fields not shown by default before printing if a particular meeting needs them.</p>

      {groups.map((g, i) => <ReportTable key={g.label?.code || i} group={g} cols={cols} milestonesByKey={milestonesByKey} dateFormat={dateFormat} />)}
      {groups.length === 0 && <div className="card empty-row">No orders match this filter.</div>}

      {showPrint && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(16,27,48,0.6)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ background: "#fff", width: "95%", maxWidth: 1400, maxHeight: "90vh", overflowY: "auto", borderRadius: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", padding: 14, background: "#F3F4F6", borderRadius: "10px 10px 0 0" }}>
              <div>Merchandising Follow-up Report — preview (Landscape A3, grouped by Label)</div>
              <div><button className="btn-ghost-sm" onClick={() => setShowPrint(false)}>Close</button> <button className="btn-primary" style={{ marginLeft: 10 }} onClick={() => window.print()}>Print</button></div>
            </div>
            <div style={{ padding: 24 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
                <div><div style={{ fontSize: 11, color: "#2B6E6A" }}>AI MERCHANDISING ERP</div><div style={{ fontSize: 18, fontWeight: 700 }}>Merchandising Follow-up Report</div></div>
                <div className="muted-sm">{groups.reduce((n, g) => n + g.rows.length, 0)} rows across {groups.length} labels</div>
              </div>
              {groups.map((g, i) => <ReportTable key={g.label?.code || i} group={g} cols={cols} milestonesByKey={milestonesByKey} dateFormat={dateFormat} />)}
              <p className="muted-sm">Printed for factory / management review — Landscape A3 recommended for the full milestone sequence.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
