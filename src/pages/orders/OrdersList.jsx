import React, { useEffect, useState } from "react";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import ExcelPreviewModal from "../../components/ExcelPreviewModal.jsx";
import { stamp } from "../../lib/exportPreview.js";
import { listOrders, getFilterOptions, assignFactory, getOrderColorWaysForOrders, getPoCancellationDetails, getExFactoryMilestonesForOrders } from "../../lib/ordersApi.js";
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

/* Read-only historical view -- entirely reuses po_cancellation_requests,
   no duplicate cancellation fields anywhere. Explicitly states the scope
   was the whole PO, using the real style count at cancellation time, so
   a multi-style/multi-color PO's details never read as if only the one
   style the user clicked into was affected. */
function CancellationDetailsModal({ poPrefix, poNumber, onClose }) {
  const [details, setDetails] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    getPoCancellationDetails(poPrefix, poNumber)
      .then(setDetails)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [poPrefix, poNumber]);

  return (
    <div className="modal-overlay">
      <div className="modal-box" style={{ width: 480 }}>
        <div className="modal-title">PO Cancellation Details — {poPrefix}{poNumber}</div>
        {loading && <p className="muted-sm">Loading...</p>}
        {error && <p style={{ color: "#B91C1C", fontSize: 13 }}>{error}</p>}
        {!loading && !error && !details?.request && (
          <p className="muted-sm">No cancellation record found for this PO — it may have been cancelled before this history was tracked.</p>
        )}
        {details?.request && (
          <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", rowGap: 10, fontSize: 13.5 }}>
            <div className="muted-sm">Status</div><div><span className="pill" style={{ background: "#FEE2E2", color: "#B91C1C" }}>Cancelled</span></div>
            <div className="muted-sm">Reason</div><div>{details.request.reason}</div>
            <div className="muted-sm">Requested by</div><div>{details.request.requested_profile?.full_name || "—"}</div>
            <div className="muted-sm">Requested date</div><div>{new Date(details.request.created_at).toLocaleString()}</div>
            <div className="muted-sm">Approved by</div><div>{details.request.reviewed_profile?.full_name || "—"}</div>
            <div className="muted-sm">Approved date</div><div>{details.request.reviewed_at ? new Date(details.request.reviewed_at).toLocaleString() : "—"}</div>
            {details.request.review_note && <><div className="muted-sm">Review note</div><div>{details.request.review_note}</div></>}
            <div className="muted-sm">Scope</div><div>Entire PO — all {details.styleCount} style{details.styleCount === 1 ? "" : "s"} and colors under {poPrefix}{poNumber}</div>
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}><button className="btn-ghost-sm" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

export default function OrdersList() {
  const { dateFormat, profile } = useOutletContext();
  const [orders, setOrders] = useState([]);
  const [options, setOptions] = useState({ customers: [], productGroups: [], factories: [], labels: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [excelSheets, setExcelSheets] = useState(null);
  const [cancellationDetailsFor, setCancellationDetailsFor] = useState(null);
  /* Arriving from a Dashboard tile. "217 Active PO" has to land on those 217
     orders, not on an unfiltered list the user then has to narrow by hand —
     that is the difference between a KPI and a dead end. Read once, on mount;
     after that the on-screen controls are in charge. */
  const [searchParams] = useSearchParams();
  /* Validated against the real tab list rather than a second copy of it, so
     an unknown value in a link degrades to "All" instead of showing an empty
     table the user cannot explain. */
  const requestedLifecycle = searchParams.get("lifecycle");
  const initialLifecycle = LIFECYCLE.some(([k]) => k === requestedLifecycle) ? requestedLifecycle : "all";
  const [lifecycle, setLifecycle] = useState(initialLifecycle);
  const [filters, setFilters] = useState({
    productGroupCode: searchParams.get("productGroup") || "",
    labelCode: searchParams.get("label") || "",
    customerCode: searchParams.get("customer") || "",
    merchandiser: searchParams.get("merchandiser") || "",
    etdFrom: searchParams.get("etdFrom") || "",
    etdTo: searchParams.get("etdTo") || "",
    factoryCode: searchParams.get("factory") || "",
    onlyMine: searchParams.get("mine") === "1",
  });
  const [searchTerm, setSearchTerm] = useState("");
  const [colorWaysByOrder, setColorWaysByOrder] = useState(new Map());

  useEffect(() => { getFilterOptions().then(setOptions); }, []);

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const apiFilters = { ...filters };
      // "All" means all active statuses -- Cancelled is its own dedicated
      // tab, not folded into "All" too, so a cancelled PO isn't shown in
      // both places at once.
      if (lifecycle !== "all") apiFilters.status = lifecycle;
      else apiFilters.excludeStatus = "cancelled";
      const result = await listOrders(apiFilters);
      setOrders(result);
      // Color-level detail, matching the same granularity Workbench
      // already shows -- confirmed as a real gap: this table previously
      // aggregated to one row per style, hiding genuinely different
      // color-level quantities under the same total.
      setColorWaysByOrder(await getOrderColorWaysForOrders(result.map(o => o.id)));
    } catch (e) { setError(e.message); }
    setLoading(false);
  }
  useEffect(() => { refresh(); }, [filters, lifecycle]);

  // Confirmed the exact reported bug by reading the code: the on-screen
  // table applied merchandiser + search filters via .filter() only in
  // the render, while exportToExcel() read the raw `orders` state
  // directly -- so whatever the user searched for on screen was silently
  // ignored by the download. Computing this once, here, and using it for
  // BOTH the table and the export is what actually fixes that; anything
  // less would just move the mismatch somewhere else.
  const filteredOrders = orders
    .filter(o => !filters.onlyMine || o.primary_merchandiser_id === profile?.id)
    .filter(o => !filters.merchandiser || o.profiles?.full_name === filters.merchandiser)
    .filter(o => !searchTerm || `${o.po_prefix}${o.po_number} ${o.style} ${o.customers?.name || ""}`.toLowerCase().includes(searchTerm.toLowerCase()));

  /* One row per order + color + shipment line -- color-level order
     quantity, never aggregated to a PO total, per the explicit
     requirement. A color with multiple partial shipments produces
     multiple rows, each with its own shipment date/vessel/destination,
     not combined into one total. An unshipped color still gets exactly
     one row, with blank shipment fields, so it's never silently missing
     from the export. Respects whichever lifecycle tab is currently
     selected, since it exports from `orders` -- the same already-filtered
     state the table itself is showing. */
  /* Three sheets, deliberately kept separate rather than one wide table --
     Order Summary (one row per order), Color Details (one row per
     order+color, with balance), Shipment Details (one row per real
     shipment_lines record -- a color with two partial shipments produces
     two rows here, never combined). Respects whichever lifecycle tab is
     currently selected, exactly like the table on screen. */
  async function exportToExcel() {
    setExporting(true); setError(null);
    try {
      const orderIds = filteredOrders.map(o => o.id);
      const [colorWaysByOrder, shipmentsByOrder, exFactoryByOrder] = await Promise.all([
        getOrderColorWaysForOrders(orderIds),
        getShipmentLinesForOrders(orderIds),
        getExFactoryMilestonesForOrders(orderIds),
      ]);

      const summaryRows = [];
      const colorRows = [];
      const shipmentRows = [];

      for (const o of filteredOrders) {
        const colorWays = colorWaysByOrder.get(o.id)?.length ? colorWaysByOrder.get(o.id) : [{ name: "—", qty: o.qty }];
        const allLines = shipmentsByOrder.get(o.id) || [];
        const exFactory = exFactoryByOrder.get(o.id);
        const leadTime = o.order_rcv_date && o.etd ? Math.round((new Date(o.etd) - new Date(o.order_rcv_date)) / 86400000) : "";

        summaryRows.push({
          "PO Prefix": o.po_prefix, "PO #": o.po_number, "Style": o.style, "Customer": o.customers?.name || "",
          "Factory": o.factories?.name || "", "Merchandiser": o.profiles?.full_name || "", "Order Qty": o.qty,
          "FOB": "fob" in o ? (o.fob ?? "") : "", "Status": o.status, "Risk": o.risk || "",
          "Product Group": o.product_groups?.name || "", "Label": o.labels?.name || "", "Business Unit": o.business_units?.name || "",
          "Season": o.season || "", "Fabric Ref": o.fabric_ref || "",
          "ETD": o.etd || "", "Revised ETD": o.revised_etd || "", "Order Rcv Date": o.order_rcv_date || "",
          "Merchandising Lead Time (days)": leadTime,
          "Ex-Factory Plan": exFactory?.plan_date || "", "Ex-Factory Actual": exFactory?.actual_date || "",
          "Ex-Factory Status": exFactory?.status || "Pending",
        });

        for (const cw of colorWays) {
          const linesForColor = allLines.filter(l => l.color_way_name === cw.name);
          const shippedQty = linesForColor.reduce((s, l) => s + l.shipped_qty, 0);
          colorRows.push({
            "PO Prefix": o.po_prefix, "PO #": o.po_number, "Style": o.style, "Color": cw.name,
            "Ordered Qty": cw.qty, "Shipped Qty": shippedQty, "Balance Qty": cw.qty - shippedQty,
            "Ex-Factory Actual": exFactory?.actual_date || "", "Status": o.status,
          });

          for (const line of linesForColor) {
            shipmentRows.push({
              "PO Prefix": o.po_prefix, "PO #": o.po_number, "Style": o.style, "Color": cw.name,
              "Shipment Qty": line.shipped_qty, "Unit Price": line.unit_price ?? "", "Shipment Value": line.shipment_value ?? "",
              "Actual ETD": line.shipments?.actual_etd || "", "Actual ETA": line.shipments?.actual_eta || "",
              "Invoice Number": line.shipments?.invoice_number || "", "Invoice Date": line.shipments?.invoice_date || "",
              "Vessel": line.shipments?.vessel || "", "Booking Date": line.shipments?.booking_date || "",
              "Destination / Port": line.shipments?.destination_port || "", "Ship Mode": line.shipments?.ship_mode || "",
            });
          }
        }
      }

      /* Preview first: the three sheets are handed to the preview modal
         to be read/copied on screen; the .xlsx is only written if the
         user asks for it there. Each sheet closes with its own totals
         row, the same bottom-line placement the report tables use. */
      const sum = (rows, key) => rows.reduce((s2, r) => s2 + (Number(r[key]) || 0), 0);
      setExcelSheets([
        { name: "Order Summary", rows: summaryRows, totals: { "PO Prefix": "Total", "Qty": sum(summaryRows, "Qty"), "Order Value": Number(sum(summaryRows, "Order Value").toFixed(2)) } },
        { name: "Color Details", rows: colorRows, totals: { "PO Prefix": "Total", "Ordered Qty": sum(colorRows, "Ordered Qty"), "Shipped Qty": sum(colorRows, "Shipped Qty"), "Balance Qty": sum(colorRows, "Balance Qty") } },
        { name: "Shipment Details", rows: shipmentRows, totals: { "PO Prefix": "Total", "Shipment Qty": sum(shipmentRows, "Shipment Qty"), "Shipment Value": Number(sum(shipmentRows, "Shipment Value").toFixed(2)) } },
      ]);
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
        {/* Factory filters at the DATABASE, not in the browser — listOrders
            already accepts factoryCode, so this narrows the query rather than
            fetching everything and hiding rows. */}
        <select value={filters.factoryCode} onChange={e => setFilters({ ...filters, factoryCode: e.target.value })} style={{ padding: 8 }}>
          <option value="">All Factories</option>
          {(options.factories || []).map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
        </select>
        <select value={filters.merchandiser} onChange={e => setFilters({ ...filters, merchandiser: e.target.value })} style={{ padding: 8 }}>
          <option value="">All Merchandisers</option>
          {merchandisers.map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        <input type="date" value={filters.etdFrom} onChange={e => setFilters({ ...filters, etdFrom: e.target.value })} style={{ padding: 8 }} title="ETD from" />
        <span style={{ alignSelf: "center", color: "#9CA3AF" }}>to</span>
        <input type="date" value={filters.etdTo} onChange={e => setFilters({ ...filters, etdTo: e.target.value })} style={{ padding: 8 }} title="ETD to" />
        <input placeholder="Search PO, style, customer…" value={searchTerm} onChange={e => setSearchTerm(e.target.value)} style={{ padding: 8, flex: 1, minWidth: 200 }} />
        <button className="btn-ghost-sm" onClick={() => { setFilters({ productGroupCode: "", labelCode: "", customerCode: "", merchandiser: "", etdFrom: "", etdTo: "", factoryCode: "", onlyMine: false }); setSearchTerm(""); setLifecycle("all"); }}>Clear Filters</button>
        <button className="btn-primary" onClick={exportToExcel} disabled={exporting || orders.length === 0}>{exporting ? "Exporting..." : "Export to Excel"}</button>
      </div>

      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
      {loading ? <p>Loading...</p> : (
        <div className="card no-pad">
          <table className="data-table">
            <thead><tr><th>Product Group</th><th>Label</th><th>BU</th><th>Customer</th><th>PO</th><th>Style</th><th>Color</th><th>Qty</th><th>FOB</th><th>ETD</th><th>Factory</th><th>Merchandiser</th><th>Status</th><th>Risk</th></tr></thead>
            <tbody>
              {filteredOrders.flatMap(o => {
                // Color-level rows, matching the same granularity
                // Workbench already shows -- confirmed as a real gap
                // otherwise: this table previously aggregated to one row
                // per style, hiding genuinely different color-level
                // quantities (e.g. OCWR2705's two colors) under one total.
                const colorWays = colorWaysByOrder.get(o.id);
                const rows = colorWays?.length ? colorWays : [{ name: "—", qty: o.qty }];
                const risk = RISK_META[o.risk] || RISK_META.onTrack;
                return rows.map((cw, i) => (
                  <tr key={`${o.id}-${cw.name}-${i}`}>
                    <td>{o.product_groups?.name || "—"}</td>
                    <td>{o.labels?.name || "—"}</td>
                    <td>{o.business_units?.name || "—"}</td>
                    <td>{o.customers?.name || "—"}</td>
                    <td><Link to={`/orders/${o.id}`} className="mono strong" style={{ color: "#2B6E6A", textDecoration: "none" }}>{o.po_prefix}{o.po_number}</Link>{o.delivery_sequence > 1 && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 600, color: "#B45309", background: "#FEF3C7", padding: "1px 6px", borderRadius: 5 }}>Del. {o.delivery_sequence}</span>}</td>
                    <td className="mono">{o.style}</td>
                    <td>{cw.name}</td>
                    <td className="mono">{cw.qty?.toLocaleString() ?? "—"}</td>
                    <td className="mono">{"fob" in o && o.fob != null ? `$${Number(o.fob).toFixed(2)}` : "—"}</td>
                    <td className="mono">{fmtCompact(o.etd, dateFormat)}</td>
                    <td>
                      {o.factories?.name
                        ? o.factories.name
                        : <QuickAssign order={o} factories={options.factories} onAssigned={refresh} />}
                    </td>
                    <td>{o.profiles?.full_name || "—"}</td>
                    <td>
                      {o.status === "cancelled"
                        ? <span className="pill" style={{ background: "#FEE2E2", color: "#B91C1C", cursor: "pointer" }} title="View cancellation details" onClick={() => setCancellationDetailsFor({ po_prefix: o.po_prefix, po_number: o.po_number })}>{o.status} ⓘ</span>
                        : <span className="pill" style={{ background: "#F3F4F6", color: "#374151" }}>{o.status}</span>}
                    </td>
                    <td><span className="risk-inline"><span className="dot" style={{ background: risk.dot }} />{risk.label}</span></td>
                  </tr>
                ));
              })}
              {filteredOrders.length === 0 && <tr><td colSpan={14} className="empty-row">No orders match this filter.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {cancellationDetailsFor && <CancellationDetailsModal poPrefix={cancellationDetailsFor.po_prefix} poNumber={cancellationDetailsFor.po_number} onClose={() => setCancellationDetailsFor(null)} />}
      {excelSheets && (
        <ExcelPreviewModal
          title={`Orders — ${lifecycle}`}
          subtitle="PEI Bangladesh · AI Merchandising ERP"
          meta="Order, colour and shipment level — exactly the rows currently filtered on screen"
          sheets={excelSheets}
          fileName={`Orders_Export_${lifecycle}_${stamp()}.xlsx`}
          onClose={() => setExcelSheets(null)}
        />
      )}
    </div>
  );
}
