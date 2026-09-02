import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import ExcelPreviewModal from "../components/ExcelPreviewModal.jsx";
import ReportPreviewModal from "../components/ReportPreviewModal.jsx";
import { stamp } from "../lib/exportPreview.js";
import { getFilterOptions } from "../lib/ordersApi.js";
import { buildShippingInvoiceRows, computeOpenOrders, computeShippedOrders } from "../lib/reportsApi.js";

/* First practical Shipping Report -- Shipping Invoice List. Reuses
   reportsApi.js entirely (buildReportDataset/computeOpenOrders/
   computeShippedOrders), the exact same functions Reports Center and the
   Shipping Dashboard already use and already tested -- no second
   calculation system, per the explicit requirement. The FY/month-pivot
   style report (each month as its own column across a full fiscal year,
   matching the Google Sheets pivot tables) is a genuinely different
   report shape and isn't built here -- noted as a clear next addition,
   not attempted as an under-tested add-on to this one. */

function fmtNum(n) { return n == null || n === "" ? "—" : Number(n).toLocaleString("en-US"); }
function fmtMoney(n) { return n == null || n === "" ? "—" : `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`; }

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default function ShippingReports() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({
    factoryCode: "", productGroupCode: "", labelCode: "", customerCode: "", status: "",
    invoiceNumber: "", po: "", style: "", dateBasis: "actual_etd", dateFrom: "", dateTo: "",
  });
  const [year, setYear] = useState("");
  const [month, setMonth] = useState("");
  const [options, setOptions] = useState({ factories: [], customers: [], productGroups: [], labels: [] });
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [excelSheets, setExcelSheets] = useState(null);
  const [pdfDescriptor, setPdfDescriptor] = useState(null);

  function applyMonthYear(y, m) {
    if (!y || m === "") { setFilters(f => ({ ...f, dateFrom: "", dateTo: "" })); return; }
    const first = new Date(Number(y), Number(m), 1);
    const last = new Date(Number(y), Number(m) + 1, 0);
    setFilters(f => ({ ...f, dateFrom: first.toISOString().slice(0, 10), dateTo: last.toISOString().slice(0, 10) }));
  }

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const r = await buildShippingInvoiceRows(filters);
      setResult(r);
      if (!options.factories.length) setOptions(await getFilterOptions());
    } catch (e) { setError(e.message); }
    setLoading(false);
  }
  useEffect(() => { refresh(); }, [filters]);

  /* Preview-first: this builds the workbook's contents and hands them to
     the preview modal. The .xlsx is written only if the user presses
     Download there. Every sheet closes with its own totals row, matching
     the on-screen table's bottom line. */
  function exportExcel() {
    if (!result) return;

    const byInvoice = new Map();
    for (const r of result.rows) {
      const key = r.invoiceNumber || "(no invoice)";
      if (!byInvoice.has(key)) byInvoice.set(key, { invoiceNumber: key, invoiceDate: r.invoiceDate, factory: r.factory, poSet: new Set(), qty: 0, value: 0 });
      const inv = byInvoice.get(key);
      inv.poSet.add(r.po); inv.qty += r.shippedQty || 0; inv.value += r.shipmentValue || 0;
    }
    const summaryRows = [...byInvoice.values()].map(inv => ({
      "Invoice Number": inv.invoiceNumber, "Invoice Date": inv.invoiceDate, "Factory": inv.factory,
      "PO(s)": [...inv.poSet].join(", "), "Total Shipped Qty": inv.qty, "Total Shipment Value": Number(inv.value.toFixed(2)),
    }));

    const detailRows = result.rows.map(r => ({
      "Invoice Number": r.invoiceNumber, "Invoice Date": r.invoiceDate, "Factory": r.factory, "PO": r.po, "Delivery": r.deliverySequence, "Style": r.style, "Color": r.color,
      "Product Group": r.productGroup, "Label": r.label, "Customer": r.customer, "Ordered Qty": r.orderedQty,
      "Shipped Qty": r.shippedQty, "Unit Price": r.unitPrice, "Shipment Value": r.shipmentValue,
    }));

    const shipmentRows = result.rows.map(r => ({
      "Invoice Number": r.invoiceNumber, "Booking Date": r.bookingDate, "Actual ETD": r.actualEtd, "Actual ETA": r.actualEta,
      "Vessel": r.vessel, "Destination Port": r.destinationPort, "Consignee": r.consignee, "PO": r.po, "Color": r.color, "Shipped Qty": r.shippedQty,
    }));

    setExcelSheets([
      { name: "Invoice Summary", rows: summaryRows, totals: {
          "Invoice Number": "Total", "PO(s)": `${new Set(result.rows.map(r => r.po)).size} POs`,
          "Total Shipped Qty": totalsRow.shippedQty, "Total Shipment Value": Number(totalsRow.value.toFixed(2)),
        } },
      { name: "PO Color Details", rows: detailRows, totals: {
          "Invoice Number": "Total", "Ordered Qty": totalsRow.orderedQty,
          "Shipped Qty": totalsRow.shippedQty, "Shipment Value": Number(totalsRow.value.toFixed(2)),
        } },
      { name: "Shipment Details", rows: shipmentRows, totals: { "Invoice Number": "Total", "Shipped Qty": totalsRow.shippedQty } },
    ]);
  }

  function exportPdf() {
    if (!result) return;
    setPdfDescriptor({
      reportName: "Shipping Invoice List",
      periodLabel: filters.dateFrom || filters.dateTo ? `Report Period: ${filters.dateFrom || "…"} to ${filters.dateTo || "…"}` : "Report Period: All dates",
      filterLabels: [
        filters.factoryCode ? `Factory: ${options.factories.find(f => f.code === filters.factoryCode)?.name || filters.factoryCode}` : null,
        filters.invoiceNumber ? `Invoice: ${filters.invoiceNumber}` : null,
        filters.status ? `Status: ${filters.status}` : null,
      ].filter(Boolean),
      kpis: [
        { label: "Invoices", value: invoiceCount },
        { label: "POs", value: poCount },
        { label: "Shipped Qty", value: fmtNum(totalsRow.shippedQty) },
        { label: "Shipment Value", value: fmtMoney(totalsRow.value) },
      ],
      columns: [
        { header: "Invoice #", key: "invoiceNumber", align: "left" },
        { header: "Invoice Date", key: "invoiceDate", align: "center" },
        { header: "Factory", key: "factory", align: "left" },
        { header: "PO", key: "po", align: "left" },
        { header: "Style", key: "style", align: "left" },
        { header: "Color", key: "color", align: "left" },
        { header: "Ordered", key: "orderedQty", align: "right" },
        { header: "Shipped", key: "shippedQty", align: "right" },
        { header: "Value", key: "shipmentValue", align: "right" },
        { header: "Actual ETD", key: "actualEtd", align: "center" },
        { header: "Destination", key: "destinationPort", align: "left" },
      ],
      rows: result.rows.map(r => ({
        invoiceNumber: r.invoiceNumber || "—", invoiceDate: r.invoiceDate || "—", factory: r.factory || "—",
        po: r.deliverySequence > 1 ? `${r.po} (Del.${r.deliverySequence})` : r.po, style: r.style, color: r.color,
        orderedQty: fmtNum(r.orderedQty), shippedQty: fmtNum(r.shippedQty),
        shipmentValue: r.shipmentValue != null ? fmtMoney(r.shipmentValue) : "—",
        actualEtd: r.actualEtd || "—", destinationPort: r.destinationPort || "—",
      })),
      totalsRow: {
        invoiceNumber: "Total", factory: `${invoiceCount} invoices`, po: `${poCount} POs`,
        orderedQty: fmtNum(totalsRow.orderedQty), shippedQty: fmtNum(totalsRow.shippedQty), shipmentValue: fmtMoney(totalsRow.value),
      },
      fileName: `PEI_BD_Shipping_Invoice_List_${stamp()}.pdf`,
    });
  }

  const open = result ? computeOpenOrders(result.orders, result.shipmentSummaryByOrder) : null;
  const shipped = result ? computeShippedOrders(result.orders, result.shipmentSummaryByOrder) : null;
  const invoiceCount = result ? new Set(result.rows.map(r => r.invoiceNumber).filter(Boolean)).size : 0;
  const poCount = result ? new Set(result.rows.map(r => r.po)).size : 0;
  /* The one bottom-line total for this report -- rendered as the table's
     <tfoot>, written as each sheet's last row, printed as the PDF's foot.
     Computed once here so those three can never disagree. */
  const totalsRow = (result ? result.rows : []).reduce((acc, r) => ({
    orderedQty: acc.orderedQty + (Number(r.orderedQty) || 0),
    shippedQty: acc.shippedQty + (Number(r.shippedQty) || 0),
    value: acc.value + (Number(r.shipmentValue) || 0),
  }), { orderedQty: 0, shippedQty: 0, value: 0 });

  return (
    <div className="rc-page">
      <button className="btn-ghost-sm" onClick={() => navigate("/shipping")} style={{ marginBottom: 12 }}>← Back to Shipping Portal</button>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 21, fontWeight: 650 }}>Shipping Reports — Invoice List</h2>
          <p style={{ margin: "3px 0 0", fontSize: 13, color: "var(--pei-muted)" }}>Every shipment line, joined back to its PO, style and colour</p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-outline" onClick={exportPdf} disabled={!result}>Preview report</button>
          <button className="btn-amber" onClick={exportExcel} disabled={!result}>Export Excel</button>
          <button className="btn-outline" onClick={exportPdf} disabled={!result}>Export PDF</button>
        </div>
      </div>
      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}

      <div className="filter-row" style={{ marginBottom: 12, flexWrap: "wrap" }}>
        <select value={filters.factoryCode} onChange={e => setFilters({ ...filters, factoryCode: e.target.value })}><option value="">All Factories</option>{options.factories.map(f => <option key={f.code} value={f.code}>{f.name}</option>)}</select>
        <select value={filters.productGroupCode} onChange={e => setFilters({ ...filters, productGroupCode: e.target.value })}><option value="">All Product Groups</option>{options.productGroups.map(p => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
        <select value={filters.labelCode} onChange={e => setFilters({ ...filters, labelCode: e.target.value })}><option value="">All Labels</option>{options.labels.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}</select>
        <select value={filters.customerCode} onChange={e => setFilters({ ...filters, customerCode: e.target.value })}><option value="">All Customers</option>{options.customers.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}</select>
        <select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })}><option value="">Open + Shipped</option><option value="shipped">Shipped Only</option><option value="production">Open (Production)</option></select>
        <input placeholder="Invoice #" value={filters.invoiceNumber} onChange={e => setFilters({ ...filters, invoiceNumber: e.target.value })} style={{ padding: 8, width: 120 }} />
        <input placeholder="PO" value={filters.po} onChange={e => setFilters({ ...filters, po: e.target.value })} style={{ padding: 8, width: 100 }} />
        <input placeholder="Style" value={filters.style} onChange={e => setFilters({ ...filters, style: e.target.value })} style={{ padding: 8, width: 110 }} />
      </div>
      <div className="filter-row" style={{ marginBottom: 16, flexWrap: "wrap" }}>
        <select value={filters.dateBasis} onChange={e => setFilters({ ...filters, dateBasis: e.target.value })}>
          <option value="actual_etd">Date basis: Actual ETD</option><option value="etd">Date basis: ETD</option><option value="crd">Date basis: CRD</option>
        </select>
        <select value={year} onChange={e => { setYear(e.target.value); applyMonthYear(e.target.value, month); }}>
          <option value="">Year</option>{[2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <select value={month} onChange={e => { setMonth(e.target.value); applyMonthYear(year, e.target.value); }}>
          <option value="">Month</option>{MONTHS.map((m, i) => <option key={m} value={i}>{m}</option>)}
        </select>
        <span className="muted-sm" style={{ alignSelf: "center" }}>or a specific range:</span>
        <input type="date" value={filters.dateFrom} onChange={e => { setYear(""); setMonth(""); setFilters({ ...filters, dateFrom: e.target.value }); }} />
        <input type="date" value={filters.dateTo} onChange={e => { setYear(""); setMonth(""); setFilters({ ...filters, dateTo: e.target.value }); }} />
      </div>

      {loading ? <p>Loading...</p> : result && (
        <>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 20 }}>
            {[
              { label: "Invoices", value: invoiceCount },
              { label: "POs", value: poCount },
              { label: "Open Qty", value: fmtNum(open.qty) },
              { label: "Open Value", value: fmtMoney(open.value) },
              { label: "Shipped Qty", value: fmtNum(shipped.qty) },
              { label: "Shipped Value", value: fmtMoney(shipped.value) },
            ].map(c => (
              <div key={c.label} style={{ padding: 16, background: "#fff", borderRadius: 10, minWidth: 130, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
                <div style={{ fontSize: 20, fontWeight: 700 }}>{c.value}</div>
                <div style={{ color: "#6B7280", fontSize: 12 }}>{c.label}</div>
              </div>
            ))}
          </div>

          <div className="card no-pad">
            <table className="rc-table">
              <thead><tr><th>Invoice #</th><th>Invoice Date</th><th>Factory</th><th>PO</th><th>Style</th><th>Color</th><th>Product Group</th><th>Label</th><th>Customer</th><th>Ordered</th><th>Shipped</th><th>Unit Price</th><th>Value</th><th>Vessel</th><th>Actual ETD</th><th>Destination</th></tr></thead>
              <tbody>
                {result.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="strong">{r.invoiceNumber || "—"}</td><td className="mono">{r.invoiceDate || "—"}</td><td>{r.factory || "—"}</td>
                    <td className="mono strong">{r.po}{r.deliverySequence > 1 && <span style={{ marginLeft: 4, fontSize: 10, color: "#B45309" }}>(Del.{r.deliverySequence})</span>}</td><td>{r.style}</td><td>{r.color}</td>
                    <td>{r.productGroup || "—"}</td><td>{r.label || "—"}</td><td>{r.customer || "—"}</td>
                    <td className="mono">{fmtNum(r.orderedQty)}</td><td className="mono">{fmtNum(r.shippedQty)}</td>
                    <td className="mono">{r.unitPrice != null ? fmtMoney(r.unitPrice) : "—"}</td><td className="mono">{r.shipmentValue != null ? fmtMoney(r.shipmentValue) : "—"}</td>
                    <td>{r.vessel || "—"}</td><td className="mono">{r.actualEtd || "—"}</td><td>{r.destinationPort || "—"}</td>
                  </tr>
                ))}
                {result.rows.length === 0 && <tr><td colSpan={16} className="empty-row">No shipment records match this filter yet.</td></tr>}
              </tbody>
              {result.rows.length > 0 && (
                <tfoot>
                  <tr>
                    <td colSpan={9}>Total — {invoiceCount} invoice{invoiceCount === 1 ? "" : "s"}, {poCount} PO{poCount === 1 ? "" : "s"}, {result.rows.length} line{result.rows.length === 1 ? "" : "s"}</td>
                    <td className="num">{fmtNum(totalsRow.orderedQty)}</td>
                    <td className="num">{fmtNum(totalsRow.shippedQty)}</td>
                    <td />
                    <td className="num">{fmtMoney(totalsRow.value)}</td>
                    <td colSpan={3} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}

      {excelSheets && (
        <ExcelPreviewModal
          title="Shipping Invoice List"
          subtitle="PEI Bangladesh · Shipping Portal"
          meta={filters.dateFrom || filters.dateTo ? `${filters.dateFrom || "…"} to ${filters.dateTo || "…"}` : "All dates"}
          sheets={excelSheets}
          fileName={`PEI_BD_Shipping_Invoice_List_${stamp()}.xlsx`}
          onClose={() => setExcelSheets(null)}
        />
      )}
      {pdfDescriptor && <ReportPreviewModal descriptor={pdfDescriptor} onClose={() => setPdfDescriptor(null)} />}
    </div>
  );
}
