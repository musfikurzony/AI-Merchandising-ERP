import React, { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { getOrdersApproachingCrd, getOrdersOverdueCrd, getOrdersWithCrdAttention, getOrdersNoRecentUpdate, getCrdRevisionCounts, groupByDimension } from "../../lib/followUpApi.js";
import { fmtCompact } from "../../lib/dateFormat.js";

/* Relocated here from Follow-up Report, per explicit instruction --
   Follow-up Report is the printable, Label-grouped milestone document
   matching v13 exactly; this is where the CRD alert/attention content
   belongs instead, matching v13's own separate "CRD Change Monitoring"
   nav item. The underlying queries (followUpApi.js) are unchanged --
   already real, already tested against live data -- only their page moved. */

const SECTIONS = [
  ["approaching", "Approaching CRD (next 7 days)"],
  ["overdue", "Overdue CRD"],
  ["attention", "CRD Attention (critical / warning)"],
  ["stale", "No Recent Update (14+ days)"],
  ["revised", "CRD Revised Multiple Times"],
];

function OrderLink({ o }) {
  if (!o) return "—";
  return <Link to={`/orders/${o.id}`} className="mono strong" style={{ color: "#2B6E6A", textDecoration: "none" }}>{o.po_prefix}{o.po_number}</Link>;
}

export default function CrdChangeMonitoring() {
  const { dateFormat } = useOutletContext();
  const [section, setSection] = useState("approaching");
  const [groupBy, setGroupBy] = useState("factory");
  const [data, setData] = useState({ approaching: [], overdue: [], attention: [], stale: [], revised: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true); setError(null);
    Promise.all([getOrdersApproachingCrd(7), getOrdersOverdueCrd(), getOrdersWithCrdAttention(), getOrdersNoRecentUpdate(14), getCrdRevisionCounts(2)])
      .then(([approaching, overdue, attention, stale, revised]) => setData({ approaching, overdue, attention, stale, revised }))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const rows = data[section] || [];
  const normalized = rows.map(r => r.order ? { order: r.order, crd: r.revisions?.[0]?.new_crd, note: `${r.revisions?.length} revisions` } : r.orders ? { order: { id: r.order_id, ...r.orders }, crd: r.new_crd, note: r.classification } : { order: r, crd: null, note: null });

  const breakdown = groupByDimension(
    normalized,
    r => groupBy === "factory" ? r.order?.factory_code : groupBy === "merchandiser" ? r.order?.profiles?.full_name : r.order?.customer_code,
    r => groupBy === "factory" ? r.order?.factories?.name || "Unassigned" : groupBy === "merchandiser" ? r.order?.profiles?.full_name || "Unassigned" : r.order?.customers?.name
  );

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginTop: 0 }}>CRD Change Monitoring</h2>
      <p className="muted-sm" style={{ marginBottom: 16 }}>Real-time CRD alerts and attention items — click any PO to open the order directly.</p>
      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}

      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {SECTIONS.map(([key, label]) => (
          <button key={key} className={"filter-chip" + (section === key ? " active" : "")} onClick={() => setSection(key)}>
            {label} ({data[key]?.length ?? 0})
          </button>
        ))}
      </div>

      {loading ? <p>Loading...</p> : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 260px", gap: 20 }}>
          <div className="card no-pad">
            <table className="data-table">
              <thead><tr><th>PO</th><th>Style</th><th>Customer</th><th>Factory</th><th>Merchandiser</th><th>CRD</th><th>Note</th></tr></thead>
              <tbody>
                {normalized.map((r, i) => (
                  <tr key={i}>
                    <td><OrderLink o={r.order} /></td>
                    <td className="mono">{r.order?.style || "—"}</td>
                    <td>{r.order?.customers?.name || "—"}</td>
                    <td>{r.order?.factories?.name || "Unassigned"}</td>
                    <td>{r.order?.profiles?.full_name || "—"}</td>
                    <td className="mono">{r.crd ? fmtCompact(r.crd, dateFormat) : "—"}</td>
                    <td>{r.note || "—"}</td>
                  </tr>
                ))}
                {normalized.length === 0 && <tr><td colSpan={7} className="empty-row">Nothing in this category.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="card">
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              {[["factory", "Factory"], ["merchandiser", "Merchandiser"], ["customer", "Customer"]].map(([k, l]) => (
                <button key={k} className={"filter-chip" + (groupBy === k ? " active" : "")} style={{ fontSize: 11.5, padding: "5px 10px" }} onClick={() => setGroupBy(k)}>{l}</button>
              ))}
            </div>
            <div style={{ fontWeight: 600, fontSize: 12.5, marginBottom: 8 }}>{SECTIONS.find(s => s[0] === section)[1]} — by {groupBy}</div>
            {breakdown.map(g => (
              <div key={g.label} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid #F2F3F6", fontSize: 12.5 }}>
                <span>{g.label}</span><span className="mono strong">{g.count}</span>
              </div>
            ))}
            {breakdown.length === 0 && <p className="muted-sm">Nothing to break down.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
