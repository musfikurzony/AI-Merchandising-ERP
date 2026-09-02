import React, { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { getFilterOptions } from "../../lib/ordersApi.js";
import {
  buildReportDataset, orderMetrics, computeOpenOrders, computeShippedOrders, computeTotalBusiness,
  computeOTDAnalysis, computeShortShipment, computeLeadTime, computeOnTimeBands,
  groupTwoLevel, groupShipmentsByDestination, stylesWithPartialShipments, seasonsIn,
} from "../../lib/reportsApi.js";
import {
  loadOrganization, resolvePeriod, defaultPeriod, activeFilterLabels,
  DATE_BASIS_OPTIONS, reportFileName,
} from "../../lib/reportContext.js";
import ReportHeader from "../../components/ReportHeader.jsx";
import DataIntegrityNotice from "../../components/DataIntegrityNotice.jsx";
import ReportFilterBar from "../../components/ReportFilterBar.jsx";
import ExcelPreviewModal from "../../components/ExcelPreviewModal.jsx";
import ReportPreviewModal from "../../components/ReportPreviewModal.jsx";

/* Reports Center — the real v13 catalog (3 categories, 9 reports) over one
   shared dataset.

   What changed in v81, and why:

   - ONE FILTER ENGINE. The bespoke filter row this screen used to carry
     was replaced by the shared <ReportFilterBar>, which every report now
     uses. Every report is therefore sliceable by the same full set of
     dimensions — factory, merchandiser, customer, product group, label,
     division, business unit, season, style, PO, status — over a period
     expressed as a fiscal year, fiscal quarter, month, date range or all
     time. No report can quietly offer fewer angles than another.

   - TWO-LEVEL GROUPING. "Group by Factory, then by Product Group" is now
     one report with expandable rows, rather than two reports or a
     filter round-trip.

   - A REAL REPORT HEADER: the organisation as configured, the period, the
     generation timestamp, who ran it, and every active filter — on screen,
     in the PDF and in the Excel file.

   - Filters need "Generate report" (they re-query the database); grouping,
     ranking and Top N apply instantly (they re-shape data already in
     hand). That distinction is stated on screen rather than left to be
     discovered. */

const CATEGORIES = ["Operational", "Performance", "Business Intelligence"];
const REPORT_CATALOG = [
  { key: "open_orders", category: "Operational", label: "Open Orders", blurb: "What is still to ship, and what it is worth" },
  { key: "shipped_orders", category: "Operational", label: "Shipped Orders", blurb: "What has gone out, by quantity and value" },
  { key: "total_business", category: "Operational", label: "Total Business", blurb: "The whole book — ordered, shipped and balance together" },
  { key: "on_time_shipment", category: "Performance", label: "On-Time Shipment", blurb: "Actual ETD against PO ETD, with how late the late ones were" },
  { key: "short_shipment", category: "Performance", label: "Short Shipment", blurb: "Where shipped quantity fell short of what was ordered" },
  { key: "lead_time", category: "Performance", label: "Lead Time", blurb: "Order received date to ETD, across the selection" },
  { key: "factory_performance", category: "Business Intelligence", label: "Factory Performance", forcedGroupBy: "factory", blurb: "Every factory compared on the same measures" },
  { key: "product_group_performance", category: "Business Intelligence", label: "Product Group Performance", forcedGroupBy: "productGroup", blurb: "Which product groups carry the business" },
  { key: "merchandiser_performance", category: "Business Intelligence", label: "Merchandiser Performance", forcedGroupBy: "merchandiser", blurb: "Workload and delivery by merchandiser" },
];

const EMPTY_FILTERS = {
  dateBasis: "etd", factoryCode: "", merchandiserId: "", customerCode: "",
  productGroupCode: "", labelCode: "", divisionCode: "", businessUnitCode: "",
  season: "", status: "", style: "", po: "",
};

function fmtNum(n) { return n == null ? "—" : Math.round(n).toLocaleString("en-US"); }
function fmtMoney(n) { return n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`; }

function KpiCard({ label, value, sub }) {
  return (
    <div className="kpi-tile">
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

function BarRow({ label, value, max, color }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
      <div style={{ width: 150, fontSize: 11.5, color: "var(--pei-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</div>
      <div style={{ flex: 1, background: "#F1EEE8", borderRadius: 4, height: 15, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, background: color, height: "100%", borderRadius: 4 }} />
      </div>
      <div className="num" style={{ width: 92, fontSize: 11.5 }}>{fmtNum(value)}</div>
    </div>
  );
}

export default function ReportsCenter() {
  const { profile } = useOutletContext() || {};
  const [org, setOrg] = useState(null);
  const [category, setCategory] = useState("Operational");
  const [reportKey, setReportKey] = useState("open_orders");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [options, setOptions] = useState({});
  const [generatedAt, setGeneratedAt] = useState(null);
  const [dirty, setDirty] = useState(false);

  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [period, setPeriod] = useState(defaultPeriod());
  const [applied, setApplied] = useState(null);
  const [groupBy, setGroupBy] = useState("factory");
  const [groupBy2, setGroupBy2] = useState("");
  const [metric, setMetric] = useState("orderedQty");
  const [topN, setTopN] = useState("");
  const [openGroups, setOpenGroups] = useState({});

  const [excelSheets, setExcelSheets] = useState(null);
  const [pdfDescriptor, setPdfDescriptor] = useState(null);

  const reportDef = REPORT_CATALOG.find(r => r.key === reportKey);
  const effectiveGroupBy = reportDef.forcedGroupBy || groupBy;

  useEffect(() => {
    loadOrganization().then(setOrg);
    getFilterOptions().then(setOptions).catch(() => {});
  }, []);

  async function generate() {
    const resolved = resolvePeriod(period);
    const query = { ...filters, dateFrom: resolved.dateFrom, dateTo: resolved.dateTo };
    setLoading(true); setError(null);
    try {
      const result = await buildReportDataset(query);
      setData(result);
      setApplied({ ...query, periodLabel: resolved.label });
      setGeneratedAt(new Date());
      setDirty(false);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }
  useEffect(() => { generate(); /* eslint-disable-next-line */ }, []);

  const grouped = useMemo(
    () => data ? groupTwoLevel(data.orders, data.shipmentSummaryByOrder, effectiveGroupBy, groupBy2 && groupBy2 !== effectiveGroupBy ? groupBy2 : null, metric, topN ? Number(topN) : null) : null,
    [data, effectiveGroupBy, groupBy2, metric, topN]
  );
  const seasons = useMemo(() => data ? seasonsIn(data.orders) : [], [data]);
  const periodLabel = applied?.periodLabel || "";
  const dateBasisLabel = (DATE_BASIS_OPTIONS.find(d => d[0] === (applied?.dateBasis || "etd")) || [])[1];
  const filterLabels = applied ? activeFilterLabels(applied, options, grouped?.dimensionLabel) : [];
  const maxMetric = grouped?.rows.length ? Math.max(...grouped.rows.map(r => r[metric] || 0)) : 0;

  function selectCategory(c) {
    setCategory(c);
    const first = REPORT_CATALOG.find(r => r.category === c);
    setReportKey(first.key);
    if (first.forcedGroupBy) setGroupBy(first.forcedGroupBy);
  }

  /* ---- KPI block per report — each reuses the exact compute function
     that report has always used; nothing is recalculated a second way. */
  function kpisFor(kind) {
    if (!data) return [];
    if (reportKey === "open_orders") {
      const r = computeOpenOrders(data.orders, data.shipmentSummaryByOrder);
      return [
        { label: "Open PO lines", value: r.poCount },
        { label: "Open qty", value: fmtNum(r.qty) },
        { label: "Open value", value: fmtMoney(r.value) },
      ];
    }
    if (reportKey === "shipped_orders") {
      const r = computeShippedOrders(data.orders, data.shipmentSummaryByOrder);
      return [
        { label: "Shipped PO lines", value: r.poCount },
        { label: "Shipped qty", value: fmtNum(r.qty) },
        { label: "Shipped value", value: fmtMoney(r.value) },
      ];
    }
    if (reportKey === "total_business") {
      const r = computeTotalBusiness(data.orders, data.shipmentSummaryByOrder);
      return [
        { label: "Total PO lines", value: r.poCount },
        { label: "Total qty", value: fmtNum(r.qty) },
        { label: "Total value", value: fmtMoney(r.value) },
      ];
    }
    if (reportKey === "on_time_shipment") {
      const r = computeOTDAnalysis(data.orders, data.shipmentSummaryByOrder);
      return [
        { label: "OTD %", value: r.otdPct == null ? "—" : `${r.otdPct}%`, sub: `${r.onTimeCount} on-time / ${r.delayedCount} delayed` },
        { label: "POs compared", value: r.totalPOs },
        { label: "Avg delay", value: r.avgDelayDays == null ? "—" : `${r.avgDelayDays}d` },
        { label: "Max delay", value: r.maxDelayDays == null ? "—" : `${r.maxDelayDays}d` },
        { label: "1–7 days late", value: r.buckets["1-7 days"] },
        { label: "8–14 days late", value: r.buckets["8-14 days"] },
        { label: ">14 days late", value: r.buckets[">14 days"] },
      ];
    }
    if (reportKey === "short_shipment") {
      const r = computeShortShipment(data.orders, data.shipmentSummaryByOrder);
      return [
        { label: "Avg short-ship %", value: r.avgShortPct == null ? "—" : `${r.avgShortPct}%` },
        { label: "Fully shipped POs", value: r.fullyShippedCount },
        { label: "Short-shipped POs", value: r.partiallyShippedCount },
        { label: "POs with any shipment", value: r.shippedOrderCount },
      ];
    }
    if (reportKey === "lead_time") {
      const r = computeLeadTime(data.orders);
      return [
        { label: "Avg lead time", value: r.avgDays == null ? "—" : `${r.avgDays}d` },
        { label: "Shortest", value: r.min == null ? "—" : `${r.min}d` },
        { label: "Longest", value: r.max == null ? "—" : `${r.max}d` },
        { label: "Sample", value: r.sampleCount, sub: "orders with both dates set" },
      ];
    }
    // Business Intelligence reports are the grouped table itself.
    if (!grouped) return [];
    return [
      { label: "Groups", value: grouped.rows.length + grouped.hiddenCount },
      { label: "PO lines", value: grouped.grandTotal.poCount },
      { label: "Ordered qty", value: fmtNum(grouped.grandTotal.orderedQty) },
      { label: "Order value", value: fmtMoney(grouped.grandTotal.orderValue) },
    ];
  }
  const kpis = kpisFor();

  /* ---- exports ---------------------------------------------------------- */
  const summaryRows = (grouped?.rows || []).flatMap(r => {
    const parent = {
      [grouped.dimensionLabel]: r.label,
      ...(grouped.dimension2Label ? { [grouped.dimension2Label]: "— all —" } : {}),
      "PO Lines": r.poCount, "Styles": r.styleCount, "Ordered Qty": r.orderedQty,
      "Shipped Qty": r.shippedQty, "Balance Qty": r.balanceQty,
      "Order Value": Number(r.orderValue.toFixed(2)),
      "Shipped %": r.orderedQty ? Number(((r.shippedQty / r.orderedQty) * 100).toFixed(1)) : 0,
    };
    const kids = (r.children || []).map(c => ({
      [grouped.dimensionLabel]: r.label, [grouped.dimension2Label]: c.label,
      "PO Lines": c.poCount, "Styles": c.styleCount, "Ordered Qty": c.orderedQty,
      "Shipped Qty": c.shippedQty, "Balance Qty": c.balanceQty,
      "Order Value": Number(c.orderValue.toFixed(2)),
      "Shipped %": c.orderedQty ? Number(((c.shippedQty / c.orderedQty) * 100).toFixed(1)) : 0,
    }));
    return [parent, ...kids];
  });
  const summaryTotals = grouped ? {
    [grouped.dimensionLabel]: grouped.truncated ? `Grand total (all ${grouped.rows.length + grouped.hiddenCount} groups)` : "Grand total",
    ...(grouped.dimension2Label ? { [grouped.dimension2Label]: "" } : {}),
    "PO Lines": grouped.grandTotal.poCount, "Styles": grouped.grandTotal.styleCount,
    "Ordered Qty": grouped.grandTotal.orderedQty, "Shipped Qty": grouped.grandTotal.shippedQty,
    "Balance Qty": grouped.grandTotal.balanceQty,
    "Order Value": Number(grouped.grandTotal.orderValue.toFixed(2)),
    "Shipped %": grouped.grandTotal.orderedQty ? Number(((grouped.grandTotal.shippedQty / grouped.grandTotal.orderedQty) * 100).toFixed(1)) : 0,
  } : null;

  function openExcel() {
    if (!data || !grouped) return;
    const orderRows = data.orders.map(o => {
      const m = orderMetrics(o, data.shipmentSummaryByOrder);
      return {
        "PO Prefix": o.po_prefix, "PO #": o.po_number, "Style": o.style, "Status": o.status,
        "Factory": o.factories?.name || "", "Merchandiser": o.profiles?.full_name || "", "Customer": o.customers?.name || "",
        "Product Group": o.product_groups?.name || "", "Label": o.labels?.name || "",
        "Division": o.divisions?.name || "", "Business Unit": o.business_units?.name || "", "Season": o.season || "",
        "Ordered Qty": m.orderedQty, "Shipped Qty": m.shippedQty, "Balance Qty": m.balanceQty, "Shipment %": m.shipmentPct,
        "Order Value": m.orderValue, "ETD": o.etd || "", "Revised ETD": o.revised_etd || "",
        "Has Partial Shipments": m.hasPartialShipments ? "Yes" : "No",
      };
    });
    const shipmentRows = data.shipmentLines.map(l => {
      const o = data.orders.find(ord => ord.id === l.order_id);
      return {
        "PO Prefix": o?.po_prefix || "", "PO #": o?.po_number || "", "Style": o?.style || "", "Color": l.color_way_name || "",
        "Shipped Qty (this shipment)": l.shipped_qty, "Unit Price": l.unit_price ?? "", "Shipment Value": l.shipment_value ?? "",
        "Vessel": l.shipments?.vessel || "", "Booking Date": l.shipments?.booking_date || "", "Actual ETD": l.shipments?.actual_etd || "",
        "Actual ETA": l.shipments?.actual_eta || "", "Destination": l.shipments?.destination_port || "", "Ship Mode": l.shipments?.ship_mode || "",
      };
    });
    const sum = (rows, key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);

    setExcelSheets([
      { name: "Summary", rows: summaryRows, totals: summaryTotals },
      {
        name: "Orders", rows: orderRows,
        totals: { "PO Prefix": "Total", "Ordered Qty": sum(orderRows, "Ordered Qty"), "Shipped Qty": sum(orderRows, "Shipped Qty"), "Balance Qty": sum(orderRows, "Balance Qty"), "Order Value": Number(sum(orderRows, "Order Value").toFixed(2)) },
      },
      {
        name: "Shipments", rows: shipmentRows,
        totals: { "PO Prefix": "Total", "Shipped Qty (this shipment)": sum(shipmentRows, "Shipped Qty (this shipment)"), "Shipment Value": Number(sum(shipmentRows, "Shipment Value").toFixed(2)) },
      },
      {
        name: "Report Info",
        rows: [
          { Field: "Report", Value: reportDef.label },
          { Field: "Company", Value: [org?.company_name, org?.branch].filter(Boolean).join(" — ") },
          { Field: "Period", Value: periodLabel },
          { Field: "Date basis", Value: dateBasisLabel },
          { Field: "Grouped by", Value: grouped.dimensionLabel + (grouped.dimension2Label ? ` → ${grouped.dimension2Label}` : "") },
          { Field: "Ranked by", Value: metric },
          { Field: "Generated", Value: (generatedAt || new Date()).toISOString() },
          { Field: "Generated by", Value: profile?.full_name || "" },
          ...filterLabels.map((f, i) => ({ Field: `Filter ${i + 1}`, Value: f })),
        ],
      },
    ]);
  }

  function openPdf() {
    if (!grouped) return;
    setPdfDescriptor({
      companyName: [org?.company_name, org?.branch].filter(Boolean).join(" — "),
      reportName: `${reportDef.label} — by ${grouped.dimensionLabel}${grouped.dimension2Label ? ` / ${grouped.dimension2Label}` : ""} — ${periodLabel}`,
      periodLabel: `Report Period: ${periodLabel} (basis: ${dateBasisLabel})`,
      filterLabels,
      kpis: kpis.slice(0, 6).map(k => ({ label: k.label, value: k.value })),
      columns: [
        { header: grouped.dimensionLabel, key: "label", align: "left" },
        { header: "PO Lines", key: "poCount", align: "right" },
        { header: "Styles", key: "styleCount", align: "right" },
        { header: "Ordered Qty", key: "orderedQty", align: "right" },
        { header: "Shipped Qty", key: "shippedQty", align: "right" },
        { header: "Balance Qty", key: "balanceQty", align: "right" },
        { header: "Order Value", key: "orderValue", align: "right" },
      ],
      rows: grouped.rows.map(r => ({
        label: r.label, poCount: r.poCount, styleCount: r.styleCount,
        orderedQty: fmtNum(r.orderedQty), shippedQty: fmtNum(r.shippedQty),
        balanceQty: fmtNum(r.balanceQty), orderValue: fmtMoney(r.orderValue),
      })),
      totalsRow: {
        label: grouped.truncated ? `Grand total (all ${grouped.rows.length + grouped.hiddenCount} groups)` : "Grand total",
        poCount: grouped.grandTotal.poCount, styleCount: grouped.grandTotal.styleCount,
        orderedQty: fmtNum(grouped.grandTotal.orderedQty), shippedQty: fmtNum(grouped.grandTotal.shippedQty),
        balanceQty: fmtNum(grouped.grandTotal.balanceQty), orderValue: fmtMoney(grouped.grandTotal.orderValue),
      },
      fileName: reportFileName(org, `${reportDef.label} by ${grouped.dimensionLabel}`, periodLabel, "pdf"),
    });
  }

  return (
    <div className="rc-page">
      <ReportHeader
        org={org}
        title={`${reportDef.label}`}
        subtitle={reportDef.blurb}
        periodLabel={periodLabel}
        dateBasisLabel={dateBasisLabel}
        generatedAt={generatedAt}
        generatedBy={profile?.full_name}
        filterLabels={filterLabels}
        recordCount={data?.orders.length}
        recordNoun="PO lines"
        right={<>
          <button className="btn-outline" onClick={openPdf} disabled={!data}>Preview report</button>
          <button className="btn-amber" onClick={openExcel} disabled={!data}>Export Excel</button>
          <button className="btn-outline" onClick={openPdf} disabled={!data}>Export PDF</button>
        </>}
      />

      <DataIntegrityNotice integrity={data?.integrity} />
      {error && <div className="bk-note warn" style={{ marginBottom: 16 }}>{error}</div>}

      {/* --- catalog ----------------------------------------------------- */}
      <div className="rc-card" style={{ marginBottom: 18 }}>
        <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
          {CATEGORIES.map(c => (
            <button key={c} className={"filter-chip" + (category === c ? " active" : "")} onClick={() => selectCategory(c)}>{c}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {REPORT_CATALOG.filter(r => r.category === category).map(r => (
            <button key={r.key} className={"chip" + (reportKey === r.key ? " active" : "")}
              onClick={() => { setReportKey(r.key); if (r.forcedGroupBy) setGroupBy(r.forcedGroupBy); }}>
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <ReportFilterBar
        filters={filters} onFilters={f => { setFilters(f); setDirty(true); }}
        period={period} onPeriod={p => { setPeriod(p); setDirty(true); }}
        options={options} seasons={seasons}
        showGrouping={!reportDef.forcedGroupBy}
        groupBy={groupBy} onGroupBy={setGroupBy}
        groupBy2={groupBy2} onGroupBy2={setGroupBy2}
        metric={metric} onMetric={setMetric}
        topN={topN} onTopN={setTopN}
        onGenerate={generate} loading={loading} dirty={dirty}
      />

      {loading && !data && <div className="rc-card">Loading…</div>}

      {data && grouped && (
        <>
          {kpis.length > 0 && (
            <div className="kpi-band">
              {kpis.map(k => <KpiCard key={k.label} label={k.label} value={k.value} sub={k.sub} />)}
            </div>
          )}

          {/* --- the grouped table, totals on the bottom line ------------ */}
          <div className="rc-card no-pad" style={{ marginBottom: 18 }}>
            <div className="rc-card-head" style={{ padding: "18px 18px 0", marginBottom: 10 }}>
              <span className="rc-card-title">
                {reportDef.label} by {grouped.dimensionLabel}{grouped.dimension2Label ? `, then by ${grouped.dimension2Label}` : ""}
              </span>
              <span className="rc-card-note">
                {grouped.dimension2Label ? "click a row to drill down · " : ""}
                {grouped.truncated
                  ? `top ${grouped.rows.length} of ${grouped.rows.length + grouped.hiddenCount} shown — the total below still covers all of them`
                  : `${grouped.rows.length} groups`}
              </span>
            </div>
            <div className="rc-scroll">
              <table className="rc-table">
                <thead>
                  <tr>
                    <th>{grouped.dimensionLabel}</th>
                    <th style={{ textAlign: "right" }}>PO Lines</th>
                    <th style={{ textAlign: "right" }}>Styles</th>
                    <th style={{ textAlign: "right" }}>Ordered Qty</th>
                    <th style={{ textAlign: "right" }}>Shipped Qty</th>
                    <th style={{ textAlign: "right" }}>Balance Qty</th>
                    <th style={{ textAlign: "right" }}>Order Value</th>
                    <th style={{ textAlign: "right" }}>Shipped %</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped.rows.map(r => {
                    const isOpen = !!openGroups[r.key];
                    const hasChildren = (r.children || []).length > 0;
                    return (
                      <React.Fragment key={r.key}>
                        <tr className={hasChildren ? "rc-parent" : ""} onClick={hasChildren ? () => setOpenGroups(g => ({ ...g, [r.key]: !isOpen })) : undefined}>
                          <td className="strong">{hasChildren && <span className="twist">{isOpen ? "▾" : "▸"}</span>}{r.label}</td>
                          <td className="num">{r.poCount}</td>
                          <td className="num">{r.styleCount}</td>
                          <td className="num">{fmtNum(r.orderedQty)}</td>
                          <td className="num">{fmtNum(r.shippedQty)}</td>
                          <td className="num">{fmtNum(r.balanceQty)}</td>
                          <td className="num">{fmtMoney(r.orderValue)}</td>
                          <td className="num">{r.orderedQty ? `${Math.round((r.shippedQty / r.orderedQty) * 100)}%` : "—"}</td>
                        </tr>
                        {isOpen && (r.children || []).map(c => (
                          <tr className="rc-child" key={c.key}>
                            <td>{c.label}</td>
                            <td className="num">{c.poCount}</td>
                            <td className="num">{c.styleCount}</td>
                            <td className="num">{fmtNum(c.orderedQty)}</td>
                            <td className="num">{fmtNum(c.shippedQty)}</td>
                            <td className="num">{fmtNum(c.balanceQty)}</td>
                            <td className="num">{fmtMoney(c.orderValue)}</td>
                            <td className="num">{c.orderedQty ? `${Math.round((c.shippedQty / c.orderedQty) * 100)}%` : "—"}</td>
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  })}
                  {grouped.rows.length === 0 && <tr><td colSpan={8} className="empty-row">No data for this filter.</td></tr>}
                </tbody>
                {grouped.rows.length > 0 && (
                  <tfoot>
                    <tr>
                      <td>{grouped.truncated ? `Grand total (all ${grouped.rows.length + grouped.hiddenCount} groups)` : "Grand total"}</td>
                      <td className="num">{grouped.grandTotal.poCount}</td>
                      <td className="num">{grouped.grandTotal.styleCount}</td>
                      <td className="num">{fmtNum(grouped.grandTotal.orderedQty)}</td>
                      <td className="num">{fmtNum(grouped.grandTotal.shippedQty)}</td>
                      <td className="num">{fmtNum(grouped.grandTotal.balanceQty)}</td>
                      <td className="num">{fmtMoney(grouped.grandTotal.orderValue)}</td>
                      <td className="num">{grouped.grandTotal.orderedQty ? `${Math.round((grouped.grandTotal.shippedQty / grouped.grandTotal.orderedQty) * 100)}%` : "—"}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          {grouped.rows.length > 0 && (
            <div className="rc-card" style={{ marginBottom: 18 }}>
              <div className="rc-card-head">
                <span className="rc-card-title">{grouped.dimensionLabel} ranked by {metric === "orderedQty" ? "ordered qty" : metric === "shippedQty" ? "shipped qty" : metric === "balanceQty" ? "balance qty" : metric === "orderValue" ? "order value" : "PO count"}</span>
              </div>
              {grouped.rows.map(g => <BarRow key={g.key} label={g.label} value={g[metric] || 0} max={maxMetric} color="var(--pei-navy-2)" />)}
            </div>
          )}

          {/* --- shipment-level panels (kept genuinely shipment-level) --- */}
          {data.shipmentLines.length > 0 && (
            <div className="rc-grid-2">
              <div className="rc-card">
                <div className="rc-card-head">
                  <span className="rc-card-title">Shipped qty by destination</span>
                  <span className="rc-card-note">counted per shipment line, not per order</span>
                </div>
                {(() => {
                  const dests = groupShipmentsByDestination(data.shipmentLines, 10);
                  const max = dests.length ? Math.max(...dests.map(d => d.qty)) : 0;
                  return dests.map(d => <BarRow key={d.destination} label={d.destination} value={d.qty} max={max} color="var(--band-ontime)" />);
                })()}
              </div>
              <div className="rc-card">
                <div className="rc-card-head">
                  <span className="rc-card-title">Colours shipped in more than one shipment</span>
                </div>
                {(() => {
                  const partials = stylesWithPartialShipments(data.shipmentLines);
                  if (partials.length === 0) return <p className="muted-sm">None in this selection.</p>;
                  return <>
                    <p className="muted-sm" style={{ marginTop: -4, marginBottom: 10 }}>{partials.length} order/colour combination(s) shipped across more than one shipment.</p>
                    {partials.slice(0, 15).map(p => {
                      const [orderId, color] = p.key.split("|");
                      const order = data.orders.find(o => o.id === orderId);
                      return (
                        <div key={p.key} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid var(--pei-border-soft)", fontSize: 12.5 }}>
                          <span>{order ? `${order.po_prefix}${order.po_number} · ${order.style} · ${color}` : color}</span>
                          <span className="num strong">{p.shipmentCount} shipments</span>
                        </div>
                      );
                    })}
                  </>;
                })()}
              </div>
            </div>
          )}
        </>
      )}

      {excelSheets && (
        <ExcelPreviewModal
          title={`${reportDef.label} — ${periodLabel}`}
          subtitle={[org?.company_name, org?.branch].filter(Boolean).join(" · ")}
          meta={filterLabels.join(" · ")}
          sheets={excelSheets}
          fileName={reportFileName(org, reportDef.label, periodLabel, "xlsx")}
          onClose={() => setExcelSheets(null)}
        />
      )}
      {pdfDescriptor && <ReportPreviewModal descriptor={pdfDescriptor} onClose={() => setPdfDescriptor(null)} />}
    </div>
  );
}
