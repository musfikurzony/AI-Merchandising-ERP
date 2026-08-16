import React, { useEffect, useMemo, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { getKpiData, rollupByDimension } from "../../lib/kpiApi.js";
import { fmtCompact } from "../../lib/dateFormat.js";

/* KPI Dashboard, Milestone 7. Every formula here was confirmed directly
   with the user, not invented -- see kpiApi.js for the single shared
   calculation module this reads from. Structural reference: v13's own KPI
   Dashboard section (FactoryAnalysisTable / ProductGroupAnalysisTable)
   confirmed the "one page, breakdown tables underneath" shape is right,
   though v13's own On-Time% was an explicitly-labeled demo heuristic, not
   a real formula -- this one uses real data throughout, including an
   honest "no data yet" for Shipping OTD until Phase 5 exists. */

function fmtNum(n) { return n == null ? "—" : Number(n).toLocaleString("en-US"); }
function fmtMoney(n) { return n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`; }

/* Plain-div bar, no charting library added for one feature -- keeps the
   same visual idea as the reference (a simple horizontal comparison) with
   zero new dependencies. */
function BarRow({ label, value, max, color }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
      <div style={{ width: 60, fontSize: 11.5, color: "#6B7280" }}>{label}</div>
      <div style={{ flex: 1, background: "#F3F4F6", borderRadius: 4, height: 16, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, background: color, height: "100%", borderRadius: 4 }} />
      </div>
      <div className="mono" style={{ width: 70, fontSize: 11.5, textAlign: "right" }}>{fmtNum(value)}</div>
    </div>
  );
}

function KpiTile({ label, value, hit, miss, pending, onClick, tone }) {
  const color = value == null ? "#9CA3AF" : value >= 90 ? "#15803D" : value >= 70 ? "#B45309" : "#B91C1C";
  return (
    <div className="card" style={{ cursor: onClick ? "pointer" : "default", borderLeft: `3px solid ${tone || color}` }} onClick={onClick}>
      <div style={{ fontSize: 11, color: "#9CA3AF", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 30, fontWeight: 700, color }}>{value == null ? "—" : `${value}%`}</div>
      <div className="muted-sm">
        {value == null ? "No data yet" : `${hit} hit / ${miss} miss${pending ? ` (${pending} pending, excluded)` : ""}`}
      </div>
    </div>
  );
}

function DrillDownModal({ title, rows, dateFormat, onClose }) {
  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ width: 720, maxHeight: "80vh", overflowY: "auto" }}>
        <div className="modal-title">{title}</div>
        <table className="data-table">
          <thead><tr><th>PO</th><th>Style</th><th>Detail</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><Link to={`/orders/${r.order?.id || r.id}`} className="mono strong" style={{ color: "#2B6E6A", textDecoration: "none" }}>{(r.order || r).po_prefix}{(r.order || r).po_number}</Link></td>
                <td className="mono">{(r.order || r).style}</td>
                <td className="muted-sm">
                  {r.plan_date !== undefined ? `Plan ${fmtCompact(r.plan_date, dateFormat)}, Actual ${r.actual_date ? fmtCompact(r.actual_date, dateFormat) : "not yet entered"}` : ""}
                  {r.crd !== undefined ? `CRD ${fmtCompact(r.crd, dateFormat)}, ${r.bufferDays} day(s) before ETD` : ""}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={3} className="empty-row">Nothing here.</td></tr>}
          </tbody>
        </table>
        <div style={{ textAlign: "right", marginTop: 12 }}><button className="btn-ghost-sm" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

const ROLLUP_DIMENSIONS = [
  ["factory", "Factory Performance", o => o.factory_code, o => o.factories?.name || "Unassigned"],
  ["merchandiser", "Merchandiser Performance", o => o.primary_merchandiser_id, o => o.profiles?.full_name || "Unassigned"],
];

export default function KpiDashboard() {
  const { dateFormat } = useOutletContext();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [drillDown, setDrillDown] = useState(null);
  const [rollupTab, setRollupTab] = useState("factory");
  const [sortKey, setSortKey] = useState("criticalPathRate");
  const [sortDir, setSortDir] = useState("asc");

  const [filters, setFilters] = useState({ factoryCode: "", merchandiserId: "", customerCode: "", productGroupCode: "", divisionCode: "", businessUnitCode: "", season: "", poStyleSearch: "", etdFrom: "", etdTo: "" });
  const [options, setOptions] = useState({ factories: [], merchandisers: [], customers: [], productGroups: [], divisions: [], businessUnits: [], seasons: [] });

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const kpiFilters = {};
      Object.entries(filters).forEach(([k, v]) => { if (v) kpiFilters[k] = v; });
      const result = await getKpiData(kpiFilters);
      setData(result);
      if (!options.factories.length) {
        setOptions({
          factories: [...new Map(result.orders.filter(o => o.factory_code).map(o => [o.factory_code, o.factories?.name])).entries()],
          merchandisers: [...new Map(result.orders.filter(o => o.primary_merchandiser_id).map(o => [o.primary_merchandiser_id, o.profiles?.full_name])).entries()],
          customers: [...new Map(result.orders.filter(o => o.customer_code).map(o => [o.customer_code, o.customers?.name])).entries()],
          productGroups: [...new Map(result.orders.filter(o => o.product_group_code).map(o => [o.product_group_code, o.product_groups?.name])).entries()],
          divisions: [...new Map(result.orders.filter(o => o.division_code).map(o => [o.division_code, o.divisions?.name])).entries()],
          businessUnits: [...new Map(result.orders.filter(o => o.business_unit_code).map(o => [o.business_unit_code, o.business_units?.name])).entries()],
          seasons: [...new Set(result.orders.map(o => o.season).filter(Boolean))],
        });
      }
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }
  useEffect(() => { refresh(); }, [filters]);

  const rollups = useMemo(() => {
    if (!data) return [];
    const [, , dimFn, labelFn] = ROLLUP_DIMENSIONS.find(d => d[0] === rollupTab);
    const rows = rollupByDimension(data, dimFn, labelFn);
    return [...rows].sort((a, b) => {
      const av = a[sortKey] ?? -1, bv = b[sortKey] ?? -1;
      return sortDir === "asc" ? av - bv : bv - av;
    });
  }, [data, rollupTab, sortKey, sortDir]);

  function toggleSort(key) {
    if (sortKey === key) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  }

  if (loading && !data) return <div style={{ padding: 32 }}>Loading...</div>;

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginTop: 0 }}>KPI Dashboard</h2>
      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}

      <div className="filter-row">
        <select value={filters.factoryCode} onChange={e => setFilters({ ...filters, factoryCode: e.target.value })}><option value="">All Factories</option>{options.factories.map(([c, n]) => <option key={c} value={c}>{n || c}</option>)}</select>
        <select value={filters.merchandiserId} onChange={e => setFilters({ ...filters, merchandiserId: e.target.value })}><option value="">All Merchandisers</option>{options.merchandisers.map(([id, n]) => <option key={id} value={id}>{n || id}</option>)}</select>
        <select value={filters.customerCode} onChange={e => setFilters({ ...filters, customerCode: e.target.value })}><option value="">All Customers</option>{options.customers.map(([c, n]) => <option key={c} value={c}>{n || c}</option>)}</select>
        <select value={filters.productGroupCode} onChange={e => setFilters({ ...filters, productGroupCode: e.target.value })}><option value="">All Product Groups</option>{options.productGroups.map(([c, n]) => <option key={c} value={c}>{n || c}</option>)}</select>
        <select value={filters.divisionCode} onChange={e => setFilters({ ...filters, divisionCode: e.target.value })}><option value="">All Divisions</option>{options.divisions.map(([c, n]) => <option key={c} value={c}>{n || c}</option>)}</select>
        <select value={filters.businessUnitCode} onChange={e => setFilters({ ...filters, businessUnitCode: e.target.value })}><option value="">All Business Units</option>{options.businessUnits.map(([c, n]) => <option key={c} value={c}>{n || c}</option>)}</select>
        <select value={filters.season} onChange={e => setFilters({ ...filters, season: e.target.value })}><option value="">All Seasons</option>{options.seasons.map(s => <option key={s} value={s}>{s}</option>)}</select>
        <input type="date" value={filters.etdFrom} onChange={e => setFilters({ ...filters, etdFrom: e.target.value })} title="ETD from" />
        <span style={{ alignSelf: "center", color: "#9CA3AF" }}>to</span>
        <input type="date" value={filters.etdTo} onChange={e => setFilters({ ...filters, etdTo: e.target.value })} title="ETD to" />
        <input placeholder="PO / Style" value={filters.poStyleSearch} onChange={e => setFilters({ ...filters, poStyleSearch: e.target.value })} style={{ padding: 8, width: 130 }} />
        <button className="btn-ghost-sm" onClick={() => setFilters({ factoryCode: "", merchandiserId: "", customerCode: "", productGroupCode: "", divisionCode: "", businessUnitCode: "", season: "", poStyleSearch: "", etdFrom: "", etdTo: "" })}>Clear Filters</button>
      </div>

      {data && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 14, marginBottom: 20 }}>
            <KpiTile label="Critical Path Hit Rate" value={data.criticalPathHitRate.rate} hit={data.criticalPathHitRate.hit} miss={data.criticalPathHitRate.miss} pending={data.criticalPathHitRate.pending}
              onClick={() => setDrillDown({ title: "Critical Path — Missed / Overdue", rows: data.criticalPathHitRate.misses.map(m => ({ ...m, order: data.orders.find(o => o.id === m.order_id) })) })} />
            <KpiTile label="Fabric In-house Hit Rate" value={data.fabricInhouseHitRate.rate} hit={data.fabricInhouseHitRate.hit} miss={data.fabricInhouseHitRate.miss} pending={data.fabricInhouseHitRate.pending}
              onClick={() => setDrillDown({ title: "Fabric In-house — Missed / Overdue", rows: data.fabricInhouseHitRate.misses.map(m => ({ ...m, order: data.orders.find(o => o.id === m.order_id) })) })} />
            <KpiTile label="PCD Hit Rate (Production Start)" value={data.pcdHitRate.rate} hit={data.pcdHitRate.hit} miss={data.pcdHitRate.miss} pending={data.pcdHitRate.pending}
              onClick={() => setDrillDown({ title: "Production Start — Missed / Overdue", rows: data.pcdHitRate.misses.map(m => ({ ...m, order: data.orders.find(o => o.id === m.order_id) })) })} />
            <KpiTile label="Merchandising OTD (CRD ≥3d before ETD)" value={data.merchandisingOtd.rate} hit={data.merchandisingOtd.hit} miss={data.merchandisingOtd.miss}
              onClick={() => setDrillDown({ title: "Merchandising OTD — Under 3-day buffer", rows: data.merchandisingOtd.misses })} />
            <KpiTile label="Shipping OTD (Actual ETD)" value={data.shippingOtd.rate} hit={data.shippingOtd.hit} miss={data.shippingOtd.miss} tone={data.shippingOtd.hasAnyData ? undefined : "#9CA3AF"} />
            <div className="card" style={{ borderLeft: `3px solid ${data.shortShipment.hasAnyData ? (data.shortShipment.avgPct <= 2 ? "#15803D" : data.shortShipment.avgPct <= 5 ? "#B45309" : "#B91C1C") : "#9CA3AF"}` }}>
              <div style={{ fontSize: 11, color: "#9CA3AF", textTransform: "uppercase" }}>Short Shipment %</div>
              <div style={{ fontSize: 30, fontWeight: 700, color: data.shortShipment.hasAnyData ? undefined : "#9CA3AF" }}>{data.shortShipment.avgPct == null ? "—" : `${data.shortShipment.avgPct}%`}</div>
              <div className="muted-sm">{data.shortShipment.hasAnyData ? `avg across ${data.shortShipment.sampleCount} shipped order(s)` : "No data yet"}</div>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14, marginBottom: 24 }}>
            <div className="card"><div className="muted-sm">Total Open Orders</div><div style={{ fontSize: 22, fontWeight: 700 }}>{data.totalOrders}</div></div>
            <div className="card"><div className="muted-sm">Critical</div><div style={{ fontSize: 22, fontWeight: 700, color: "#B91C1C" }}>{data.riskCounts.critical}</div></div>
            <div className="card"><div className="muted-sm">At Risk</div><div style={{ fontSize: 22, fontWeight: 700, color: "#B45309" }}>{data.riskCounts.atRisk}</div></div>
            <div className="card"><div className="muted-sm">Overdue Milestones</div><div style={{ fontSize: 22, fontWeight: 700, color: "#B91C1C" }}>{data.overdueMilestoneCount}</div></div>
          </div>

          <div className="card" style={{ marginBottom: 24 }}>
            <div style={{ fontWeight: 600, marginBottom: 14 }}>Open vs. Shipped — how much is still to go out</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
              <div>
                <div className="muted-sm">Open (still to ship)</div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{fmtNum(data.openShippedSummary.openQty)} <span className="muted-sm" style={{ fontWeight: 400 }}>units, {data.openShippedSummary.openOrders} orders</span></div>
                {data.openShippedSummary.openValue != null && <div className="mono" style={{ color: "#B45309" }}>{fmtMoney(data.openShippedSummary.openValue)}</div>}
              </div>
              <div>
                <div className="muted-sm">Shipped</div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{fmtNum(data.openShippedSummary.shippedQty)} <span className="muted-sm" style={{ fontWeight: 400 }}>units, {data.openShippedSummary.shippedOrders} orders</span></div>
                {data.openShippedSummary.shippedValue != null && <div className="mono" style={{ color: "#15803D" }}>{fmtMoney(data.openShippedSummary.shippedValue)}</div>}
              </div>
            </div>
            {(data.openShippedSummary.openQty > 0 || data.openShippedSummary.shippedQty > 0) && (
              <div style={{ marginTop: 16 }}>
                <BarRow label="Open" value={data.openShippedSummary.openQty} max={Math.max(data.openShippedSummary.openQty, data.openShippedSummary.shippedQty)} color="#B45309" />
                <BarRow label="Shipped" value={data.openShippedSummary.shippedQty} max={Math.max(data.openShippedSummary.openQty, data.openShippedSummary.shippedQty)} color="#15803D" />
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {ROLLUP_DIMENSIONS.map(([key, label]) => (
              <button key={key} className={"filter-chip" + (rollupTab === key ? " active" : "")} onClick={() => setRollupTab(key)}>{label}</button>
            ))}
          </div>
          <div className="card no-pad">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{rollupTab === "factory" ? "Factory" : "Merchandiser"}</th>
                  <th className="sortable" onClick={() => toggleSort("criticalPathRate")}>Critical Path {sortKey === "criticalPathRate" ? (sortDir === "asc" ? "▲" : "▼") : ""}</th>
                  <th className="sortable" onClick={() => toggleSort("fabricInhouseRate")}>Fabric In-house {sortKey === "fabricInhouseRate" ? (sortDir === "asc" ? "▲" : "▼") : ""}</th>
                  <th className="sortable" onClick={() => toggleSort("pcdRate")}>PCD {sortKey === "pcdRate" ? (sortDir === "asc" ? "▲" : "▼") : ""}</th>
                  <th className="sortable" onClick={() => toggleSort("merchandisingOtdRate")}>Merch. OTD {sortKey === "merchandisingOtdRate" ? (sortDir === "asc" ? "▲" : "▼") : ""}</th>
                  <th className="sortable" onClick={() => toggleSort("shippingOtdRate")}>Ship OTD {sortKey === "shippingOtdRate" ? (sortDir === "asc" ? "▲" : "▼") : ""}</th>
                  <th className="sortable" onClick={() => toggleSort("shortShipPct")}>Short Ship {sortKey === "shortShipPct" ? (sortDir === "asc" ? "▲" : "▼") : ""}</th>
                  <th className="sortable" onClick={() => toggleSort("openQty")}>Open Qty {sortKey === "openQty" ? (sortDir === "asc" ? "▲" : "▼") : ""}</th>
                  <th>Open Value</th>
                  <th className="sortable" onClick={() => toggleSort("shippedQty")}>Shipped Qty {sortKey === "shippedQty" ? (sortDir === "asc" ? "▲" : "▼") : ""}</th>
                  <th>Shipped Value</th>
                  <th className="sortable" onClick={() => toggleSort("totalOrders")}>Orders {sortKey === "totalOrders" ? (sortDir === "asc" ? "▲" : "▼") : ""}</th>
                  <th>Critical</th><th>At Risk</th><th>On Track</th>
                  <th className="sortable" onClick={() => toggleSort("overdueMilestones")}>Overdue {sortKey === "overdueMilestones" ? (sortDir === "asc" ? "▲" : "▼") : ""}</th>
                </tr>
              </thead>
              <tbody>
                {rollups.map(r => (
                  <tr key={r.key}>
                    <td className="strong">{r.label}</td>
                    <td className="mono">{r.criticalPathRate == null ? "—" : `${r.criticalPathRate}%`}</td>
                    <td className="mono">{r.fabricInhouseRate == null ? "—" : `${r.fabricInhouseRate}%`}</td>
                    <td className="mono">{r.pcdRate == null ? "—" : `${r.pcdRate}%`}</td>
                    <td className="mono">{r.merchandisingOtdRate == null ? "—" : `${r.merchandisingOtdRate}%`}</td>
                    <td className="mono">{r.shippingOtdRate == null ? "—" : `${r.shippingOtdRate}%`}</td>
                    <td className="mono">{r.shortShipPct == null ? "—" : `${r.shortShipPct}%`}</td>
                    <td className="mono">{fmtNum(r.openQty)}</td>
                    <td className="mono">{r.openValue == null ? "—" : fmtMoney(r.openValue)}</td>
                    <td className="mono">{fmtNum(r.shippedQty)}</td>
                    <td className="mono">{r.shippedValue == null ? "—" : fmtMoney(r.shippedValue)}</td>
                    <td className="mono">{r.totalOrders}</td>
                    <td className="mono" style={{ color: "#B91C1C" }}>{r.critical}</td>
                    <td className="mono" style={{ color: "#B45309" }}>{r.atRisk}</td>
                    <td className="mono" style={{ color: "#15803D" }}>{r.onTrack}</td>
                    <td className="mono">{r.overdueMilestones}</td>
                  </tr>
                ))}
                {rollups.length === 0 && <tr><td colSpan={16} className="empty-row">No data for this filter.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {drillDown && <DrillDownModal title={drillDown.title} rows={drillDown.rows} dateFormat={dateFormat} onClose={() => setDrillDown(null)} />}
    </div>
  );
}
