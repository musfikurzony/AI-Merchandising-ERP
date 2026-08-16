import React, { useEffect, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import * as XLSX from "xlsx";
import { listOrders, getFilterOptions, assignFactory, getOrderColorWaysForOrders } from "../../lib/ordersApi.js";
import { getShipmentLinesForOrders } from "../../lib/shipmentApi.js";
import { fmtCompact } from "../../lib/dateFormat.js";

const LIFECYCLE = [
  ["all", "All"], ["unassigned", "Unassigned"], ["sourcing", "Sourcing"],
  ["production", "In Production"], ["shipped", "Shipped"], ["cancelled", "Cancelled"],
];
const RISK_META = {
  onTrack: { label: "On Track", dot: "#15803D" }, atRisk: { label: "At Risk", dot: "#B45309" },
  critical: { label: "Critical", dot: "#B91C1C" }, aging: { label: "Aging", dot: "#B91C1C" },
};

/* Quick, inline factory assignment right from the list -- confirmed a
   real gap: with hundreds of orders arriving from a PLM import, opening
   each one individually via Order Detail just to assign a factory wasn't
   practical. Calls the same (now PO-scoped, not style-scoped) assignFactory()
   used everywhere else -- one place, one fix, no separate logic here. */
function QuickAssign({ order, factories, onAssigned }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(factories[0]?.code || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function assign() {
    setSaving(true); setError(null);
    try { await assignFactory(order.id, selected); setOpen(false); await onAssigned(); }
    catch (e) { setError(e.message); }
    setSaving(false);
  }

  if (!open) return <button className="btn-ghost-sm" onClick={() => setOpen(true)}>Assign</button>;
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
      <select value={selected} onChange={e => setSelected(e.target.value)} style={{ padding: 4, fontSize: 12 }}>
        {factories.map(f => <option key={f.code} value={f.code}>{f.code}</option>)}
      </select>
      <button className="btn-primary" style={{ padding: "4px 8px", fontSize: 12 }} onClick={assign} disabled={saving}>{saving ? "..." : "Go"}</button>
      <button className="btn-ghost-sm" style={{ padding: "4px 6px", fontSize: 12 }} onClick={() => setOpen(false)}>×</button>
      {error && <span style={{ color: "#B91C1C", fontSize: 11 }}>{error}</span>}
    </div>
  );
}

export default function OrdersList() {
  const { dateFormat } = useOutletContext();
  const [orders, setOrders] = useState([]);
  const [options, setOptions] = useState({ customers: [], productGroups: [], factories: [], labels: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [lifecycle, setLifecycle] = useState("all");
  const [filters, setFilters] = useState({ po: "", productGroupCode: "", labelCode: "", customerCode: "", merchandiser: "", etdFrom: "", etdTo: "" });

  useEffect(() => { getFilterOptions().then(setOptions); }, []);

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const apiFilters = { ...filters };
      if (lifecycle !== "all") apiFilters.status = lifecycle;
      setOrders(await listOrders(apiFilters));
    } catch (e) { setError(e.message); }
    setLoading(false);
  }
  useEffect(() => { refresh(); }, [filters, lifecycle]);

  /* One row per order + color + shipment line -- color-level order
     quantity, never aggregated to a PO total, per the explicit
     requirement. A color with multiple partial shipments produces
     multiple rows, each with its own shipment date/vessel/destination,
     not combined into one total. An unshipped color still gets exactly
     one row, with blank shipment fields, so it's never silently missing
     from the export. Respects whichever lifecycle tab is currently
     selected, since it exports from `orders` -- the same already-filtered
     state the table itself is showing. */
  async function exportToExcel() {
    setExporting(true); setError(null);
    try {
      const orderIds = orders.map(o => o.id);
      const [colorWaysByOrder, shipmentsByOrder] = await Promise.all([
        getOrderColorWaysForOrders(orderIds),
        getShipmentLinesForOrders(orderIds),
      ]);

      const rows = [];
      for (const o of orders) {
        const colorWays = colorWaysByOrder.get(o.id)?.length ? colorWaysByOrder.get(o.id) : [{ name: "—", qty: o.qty }];
        const leadTime = o.order_rcv_date && o.etd ? Math.round((new Date(o.etd) - new Date(o.order_rcv_date)) / 86400000) : "";
        const allLines = shipmentsByOrder.get(o.id) || [];

        const baseRow = {
          "PO Prefix": o.po_prefix, "PO #": o.po_number, "Style": o.style,
          "FOB": "fob" in o ? (o.fob ?? "") : "", "Fabric Ref": o.fabric_ref || "",
          "Product Group": o.product_groups?.name || "", "Label": o.labels?.name || "",
          "Division": o.divisions?.name || "", "Business Unit": o.business_units?.name || "", "Customer": o.customers?.name || "",
          "Season": o.season || "", "Factory": o.factories?.name || "", "Merchandiser": o.profiles?.full_name || "",
          "Status": o.status, "Risk": o.risk || "", "ETD": o.etd || "", "Revised ETD": o.revised_etd || "",
          "Order Rcv Date": o.order_rcv_date || "", "Merchandising Lead Time (days)": leadTime,
        };

        for (const cw of colorWays) {
          const linesForColor = allLines.filter(l => l.color_way_name === cw.name);
          const totalShipped = linesForColor.reduce((s, l) => s + l.shipped_qty, 0);
          const balance = cw.qty - totalShipped;
          const orderValue = "fob" in o && o.fob != null ? Math.round(cw.qty * o.fob * 100) / 100 : "";

          if (linesForColor.length === 0) {
            rows.push({ ...baseRow, "Color": cw.name, "Ordered Qty": cw.qty, "Order Value": orderValue,
              "Shipped Qty (this shipment)": "", "Balance": balance, "Vessel": "", "Booking Date": "",
              "Actual ETD": "", "Actual ETA": "", "Destination Port": "", "Invoice Number": "", "Invoice Date": "", "Shipment Value": "" });
          } else {
            for (const line of linesForColor) {
              rows.push({ ...baseRow, "Color": cw.name, "Ordered Qty": cw.qty, "Order Value": orderValue,
                "Shipped Qty (this shipment)": line.shipped_qty, "Balance": balance,
                "Vessel": line.shipments?.vessel || "", "Booking Date": line.shipments?.booking_date || "",
                "Actual ETD": line.shipments?.actual_etd || "", "Actual ETA": line.shipments?.actual_eta || "",
                "Destination Port": line.shipments?.destination_port || "", "Invoice Number": line.shipments?.invoice_number || "",
                "Invoice Date": line.shipments?.invoice_date || "", "Shipment Value": line.shipment_value ?? "" });
            }
          }
        }
      }

      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Orders Export");
      XLSX.writeFile(wb, `Orders_Export_${lifecycle}_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      setError(e.message);
    }
    setExporting(false);
  }

  const merchandisers = [...new Set(orders.map(o => o.profiles?.full_name).filter(Boolean))];

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginTop: 0, marginBottom: 16 }}>Orders</h2>

      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {LIFECYCLE.map(([key, label]) => (
          <button key={key} className={"filter-chip" + (lifecycle === key ? " active" : "")} onClick={() => setLifecycle(key)}>{label}</button>
        ))}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <select value={filters.productGroupCode} onChange={e => setFilters({ ...filters, productGroupCode: e.target.value })} style={{ padding: 8 }}>
          <option value="">All Product Groups</option>
          {options.productGroups.map(p => <option key={p.code} value={p.code}>{p.name}</option>)}
        </select>
        <select value={filters.labelCode} onChange={e => setFilters({ ...filters, labelCode: e.target.value })} style={{ padding: 8 }}>
          <option value="">All Labels</option>
          {options.labels.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
        <select value={filters.customerCode} onChange={e => setFilters({ ...filters, customerCode: e.target.value })} style={{ padding: 8 }}>
          <option value="">All Customers</option>
          {options.customers.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
        </select>
        <select value={filters.merchandiser} onChange={e => setFilters({ ...filters, merchandiser: e.target.value })} style={{ padding: 8 }}>
          <option value="">All Merchandisers</option>
          {merchandisers.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <input type="date" value={filters.etdFrom} onChange={e => setFilters({ ...filters, etdFrom: e.target.value })} style={{ padding: 8 }} title="ETD from" />
        <span style={{ alignSelf: "center", color: "#9CA3AF" }}>to</span>
        <input type="date" value={filters.etdTo} onChange={e => setFilters({ ...filters, etdTo: e.target.value })} style={{ padding: 8 }} title="ETD to" />
        <input placeholder="Filter by PO, style, customer..." value={filters.po} onChange={e => setFilters({ ...filters, po: e.target.value })} style={{ padding: 8, flex: 1, minWidth: 200 }} />
        <button className="btn-ghost-sm" onClick={() => { setFilters({ po: "", productGroupCode: "", labelCode: "", customerCode: "", merchandiser: "", etdFrom: "", etdTo: "" }); setLifecycle("all"); }}>Clear Filters</button>
        <button className="btn-primary" onClick={exportToExcel} disabled={exporting || orders.length === 0}>{exporting ? "Exporting..." : "Export to Excel"}</button>
      </div>

      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
      {loading ? <p>Loading...</p> : (
        <div className="card no-pad">
          <table className="data-table">
            <thead><tr><th>PO</th><th>Style</th><th>Product Group</th><th>Label</th><th>BU</th><th>Customer</th><th>Qty</th><th>FOB</th><th>ETD</th><th>Factory</th><th>Merchandiser</th><th>Status</th><th>Risk</th></tr></thead>
            <tbody>
              {orders.filter(o => !filters.merchandiser || o.profiles?.full_name === filters.merchandiser).map(o => {
                const risk = RISK_META[o.risk] || RISK_META.onTrack;
                return (
                  <tr key={o.id}>
                    <td><Link to={`/orders/${o.id}`} className="mono strong" style={{ color: "#2B6E6A", textDecoration: "none" }}>{o.po_prefix}{o.po_number}</Link></td>
                    <td className="mono">{o.style}</td>
                    <td>{o.product_groups?.name || "—"}</td>
                    <td>{o.labels?.name || "—"}</td>
                    <td>{o.business_units?.name || "—"}</td>
                    <td>{o.customers?.name || "—"}</td>
                    <td className="mono">{o.qty?.toLocaleString() ?? "—"}</td>
                    <td className="mono">{"fob" in o && o.fob != null ? `$${Number(o.fob).toFixed(2)}` : "—"}</td>
                    <td className="mono">{fmtCompact(o.etd, dateFormat)}</td>
                    <td>
                      {o.factories?.name
                        ? o.factories.name
                        : <QuickAssign order={o} factories={options.factories} onAssigned={refresh} />}
                    </td>
                    <td>{o.profiles?.full_name || "—"}</td>
                    <td><span className="pill" style={o.status === "cancelled" ? { background: "#FEE2E2", color: "#B91C1C" } : { background: "#F3F4F6", color: "#374151" }}>{o.status}</span></td>
                    <td><span className="risk-inline"><span className="dot" style={{ background: risk.dot }} />{risk.label}</span></td>
                  </tr>
                );
              })}
              {orders.length === 0 && <tr><td colSpan={13} className="empty-row">No orders match this filter.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
