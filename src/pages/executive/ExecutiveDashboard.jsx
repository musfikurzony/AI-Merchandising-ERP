import React, { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, PieChart, Pie, Cell,
} from "recharts";
import { getFilterOptions } from "../../lib/ordersApi.js";
import {
  buildReportDataset, computeBusinessSummary, computeOnTimeBands, computeShortShipment,
  groupTwoLevel, monthlyShipmentSeries, seasonsIn, attentionList,
  SERIES_PLANNED, SERIES_ACTUAL,
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
import { fmtCompact } from "../../lib/dateFormat.js";

/* Executive Dashboard — the management view of the whole book of business.

   It reads the SAME dataset and the SAME compute functions every
   operational report reads (buildReportDataset → computeBusinessSummary /
   computeOnTimeBands / computeShortShipment / groupTwoLevel). That is the
   point: an executive number that disagrees with the merchandiser's own
   screen is worse than no number, so there is deliberately no separate
   "executive aggregate" query anywhere in this file.

   Every figure here is filterable from the same angles as every other
   report — factory, merchandiser, customer, product group, label,
   division, business unit, season, style, PO, status, and a period
   expressed as a fiscal year, fiscal quarter, month, free date range or
   all time. */

const EMPTY_FILTERS = {
  dateBasis: "etd", factoryCode: "", merchandiserId: "", customerCode: "",
  productGroupCode: "", labelCode: "", divisionCode: "", businessUnitCode: "",
  season: "", status: "", style: "", po: "",
};

function fmtNum(n) { return n == null ? "—" : Math.round(n).toLocaleString("en-US"); }
function fmtMoney(n) { return n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`; }
function fmtMoney2(n) { return n == null ? "—" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }

function KpiTile({ label, value, sub, accent }) {
  return (
    <div className={"kpi-tile" + (accent ? " accent" : "")}>
      <div className="l">{label}</div>
      <div className="v">{value}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

export default function ExecutiveDashboard() {
  const { dateFormat, profile } = useOutletContext() || {};
  const [org, setOrg] = useState(null);
  const [options, setOptions] = useState({});
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [period, setPeriod] = useState(defaultPeriod());
  const [applied, setApplied] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [generatedAt, setGeneratedAt] = useState(null);
  const [dirty, setDirty] = useState(false);

  const [groupBy, setGroupBy] = useState("factory");
  const [groupBy2, setGroupBy2] = useState("");
  const [metric, setMetric] = useState("orderedQty");
  const [topN, setTopN] = useState("");
  const [openGroups, setOpenGroups] = useState({});
  const [trendMetric, setTrendMetric] = useState("qty");

  const [excelSheets, setExcelSheets] = useState(null);
  const [pdfDescriptor, setPdfDescriptor] = useState(null);

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

  const summary = useMemo(() => data ? computeBusinessSummary(data.orders, data.shipmentSummaryByOrder) : null, [data]);
  const bands = useMemo(() => data ? computeOnTimeBands(data.orders, data.shipmentSummaryByOrder, groupBy) : null, [data, groupBy]);
  const shortShip = useMemo(() => data ? computeShortShipment(data.orders, data.shipmentSummaryByOrder) : null, [data]);
  const grouped = useMemo(() => data ? groupTwoLevel(data.orders, data.shipmentSummaryByOrder, groupBy, groupBy2 || null, metric, topN ? Number(topN) : null) : null, [data, groupBy, groupBy2, metric, topN]);
  const trend = useMemo(() => data && applied ? monthlyShipmentSeries(data.orders, data.shipmentLines, data.shipmentSummaryByOrder, applied.dateFrom, applied.dateTo) : [], [data, applied]);
  const attention = useMemo(() => data ? attentionList(data.orders, data.shipmentSummaryByOrder) : [], [data]);
  const seasons = useMemo(() => data ? seasonsIn(data.orders) : [], [data]);

  const periodLabel = applied?.periodLabel || "";
  const dateBasisLabel = (DATE_BASIS_OPTIONS.find(d => d[0] === (applied?.dateBasis || "etd")) || [])[1];
  const filterLabels = applied ? activeFilterLabels(applied, options, grouped?.dimensionLabel) : [];
  const onTimePct = bands && bands.totals.poCount ? (bands.bands[0].poCount / bands.totals.poCount) * 100 : null;

  function onFiltersChange(next) { setFilters(next); setDirty(true); }
  function onPeriodChange(next) { setPeriod(next); setDirty(true); }

  /* ---- exports: same rows on screen, in the sheet and in the document -- */
  const groupSheetRows = (grouped?.rows || []).flatMap(r => {
    const parent = {
      [grouped.dimensionLabel]: r.label,
      ...(grouped.dimension2Label ? { [grouped.dimension2Label]: "— all —" } : {}),
      "PO Lines": r.poCount, "Styles": r.styleCount,
      "Ordered Qty": r.orderedQty, "Shipped Qty": r.shippedQty, "Balance Qty": r.balanceQty,
      "Order Value": Number(r.orderValue.toFixed(2)), "Shipped Value": Number(r.shippedValue.toFixed(2)),
      "Shipped %": r.orderedQty ? Number(((r.shippedQty / r.orderedQty) * 100).toFixed(1)) : 0,
    };
    const children = (r.children || []).map(c => ({
      [grouped.dimensionLabel]: r.label,
      [grouped.dimension2Label]: c.label,
      "PO Lines": c.poCount, "Styles": c.styleCount,
      "Ordered Qty": c.orderedQty, "Shipped Qty": c.shippedQty, "Balance Qty": c.balanceQty,
      "Order Value": Number(c.orderValue.toFixed(2)), "Shipped Value": Number(c.shippedValue.toFixed(2)),
      "Shipped %": c.orderedQty ? Number(((c.shippedQty / c.orderedQty) * 100).toFixed(1)) : 0,
    }));
    return [parent, ...children];
  });
  const groupSheetTotals = grouped ? {
    [grouped.dimensionLabel]: "Grand total",
    ...(grouped.dimension2Label ? { [grouped.dimension2Label]: "" } : {}),
    "PO Lines": grouped.grandTotal.poCount, "Styles": grouped.grandTotal.styleCount,
    "Ordered Qty": grouped.grandTotal.orderedQty, "Shipped Qty": grouped.grandTotal.shippedQty,
    "Balance Qty": grouped.grandTotal.balanceQty,
    "Order Value": Number(grouped.grandTotal.orderValue.toFixed(2)),
    "Shipped Value": Number(grouped.grandTotal.shippedValue.toFixed(2)),
    "Shipped %": grouped.grandTotal.orderedQty ? Number(((grouped.grandTotal.shippedQty / grouped.grandTotal.orderedQty) * 100).toFixed(1)) : 0,
  } : null;

  function openExcel() {
    if (!summary) return;
    setExcelSheets([
      {
        name: "Executive Summary",
        rows: [
          { Measure: "Total business — PO lines", Value: summary.orderLineCount },
          { Measure: "Total business — distinct POs", Value: summary.poCount },
          { Measure: "Total business — styles", Value: summary.styleCount },
          { Measure: "Total ordered qty", Value: summary.orderedQty },
          { Measure: "Total order value", Value: Number(summary.orderValue.toFixed(2)) },
          { Measure: "Open orders", Value: summary.open.count },
          { Measure: "Open qty", Value: summary.open.qty },
          { Measure: "Open value", Value: Number(summary.open.value.toFixed(2)) },
          { Measure: "Shipped orders", Value: summary.shipped.count },
          { Measure: "Shipped qty", Value: summary.shipped.qty },
          { Measure: "Shipped value", Value: Number(summary.shipped.value.toFixed(2)) },
          { Measure: "Shipment completion %", Value: summary.shipmentPct },
          { Measure: "On-time %", Value: onTimePct == null ? "" : Number(onTimePct.toFixed(1)) },
          { Measure: "POs compared for on-time", Value: bands?.totals.poCount ?? 0 },
          { Measure: "Average short-ship %", Value: shortShip?.avgShortPct ?? "" },
          { Measure: "Cancelled PO lines", Value: summary.cancelledCount },
          { Measure: "Orders needing attention", Value: attention.length },
        ],
      },
      { name: `By ${grouped.dimensionLabel}`, rows: groupSheetRows, totals: groupSheetTotals },
      {
        name: "Monthly Trend",
        rows: trend.map(m => ({
          Month: m.label, "Ordered Qty (by ETD)": m.orderedQty,
          "Order Value": Number(m.orderValue.toFixed(2)),
          "Shipped Qty (actual)": m.shippedQty, "Shipped Value": Number(m.shippedValue.toFixed(2)),
          "PO Lines Due": m.poCount,
        })),
        totals: {
          Month: "Total",
          "Ordered Qty (by ETD)": trend.reduce((s, m) => s + m.orderedQty, 0),
          "Order Value": Number(trend.reduce((s, m) => s + m.orderValue, 0).toFixed(2)),
          "Shipped Qty (actual)": trend.reduce((s, m) => s + m.shippedQty, 0),
          "Shipped Value": Number(trend.reduce((s, m) => s + m.shippedValue, 0).toFixed(2)),
          "PO Lines Due": trend.reduce((s, m) => s + m.poCount, 0),
        },
      },
      {
        name: "On-Time Bands",
        rows: (bands?.bands || []).map(b => ({
          Status: b.label, "No. of POs": b.poCount, "% of POs": Number(b.pctOfPos.toFixed(1)),
          "Ship Qty": b.shipQty, "Ship Value": Number(b.shipValue.toFixed(2)),
        })),
        totals: bands ? { Status: "Total", "No. of POs": bands.totals.poCount, "% of POs": bands.totals.poCount ? 100 : 0, "Ship Qty": bands.totals.shipQty, "Ship Value": Number(bands.totals.shipValue.toFixed(2)) } : null,
      },
      {
        name: "Needs Attention",
        rows: attention.map(a => ({
          Severity: a.severity === "critical" ? "Critical" : "Warning",
          PO: `${a.order.po_prefix}${a.order.po_number}`, Style: a.order.style,
          Factory: a.order.factories?.name || "Unassigned",
          Merchandiser: a.order.profiles?.full_name || "Unassigned",
          Customer: a.order.customers?.name || "", Status: a.order.status,
          ETD: a.order.revised_etd || a.order.etd || "",
          "Ordered Qty": a.orderedQty, "Shipped Qty": a.shippedQty, "Balance Qty": a.balanceQty,
          Reason: a.reason,
        })),
      },
    ]);
  }

  function openPdf() {
    if (!summary || !grouped) return;
    setPdfDescriptor({
      companyName: [org?.company_name, org?.branch].filter(Boolean).join(" — "),
      reportName: `Executive Business Report — ${periodLabel}`,
      periodLabel: `Report Period: ${periodLabel} (basis: ${dateBasisLabel})`,
      filterLabels,
      kpis: [
        { label: "Total qty", value: fmtNum(summary.orderedQty) },
        { label: "Total value", value: fmtMoney(summary.orderValue) },
        { label: "Open value", value: fmtMoney(summary.open.value) },
        { label: "Shipped value", value: fmtMoney(summary.shipped.value) },
        { label: "Shipped %", value: `${summary.shipmentPct}%` },
        { label: "On-time %", value: onTimePct == null ? "—" : `${onTimePct.toFixed(1)}%` },
        { label: "Needs attention", value: attention.length },
      ],
      columns: [
        { header: grouped.dimensionLabel, key: "label", align: "left" },
        { header: "PO Lines", key: "poCount", align: "right" },
        { header: "Styles", key: "styleCount", align: "right" },
        { header: "Ordered Qty", key: "orderedQty", align: "right" },
        { header: "Shipped Qty", key: "shippedQty", align: "right" },
        { header: "Balance Qty", key: "balanceQty", align: "right" },
        { header: "Order Value", key: "orderValue", align: "right" },
        { header: "Shipped %", key: "pct", align: "right" },
      ],
      rows: grouped.rows.map(r => ({
        label: r.label, poCount: r.poCount, styleCount: r.styleCount,
        orderedQty: fmtNum(r.orderedQty), shippedQty: fmtNum(r.shippedQty),
        balanceQty: fmtNum(r.balanceQty), orderValue: fmtMoney(r.orderValue),
        pct: r.orderedQty ? `${Math.round((r.shippedQty / r.orderedQty) * 100)}%` : "—",
      })),
      totalsRow: {
        label: grouped.truncated ? `Grand total (all ${grouped.rows.length + grouped.hiddenCount} groups)` : "Grand total",
        poCount: grouped.grandTotal.poCount, styleCount: grouped.grandTotal.styleCount,
        orderedQty: fmtNum(grouped.grandTotal.orderedQty), shippedQty: fmtNum(grouped.grandTotal.shippedQty),
        balanceQty: fmtNum(grouped.grandTotal.balanceQty), orderValue: fmtMoney(grouped.grandTotal.orderValue),
        pct: grouped.grandTotal.orderedQty ? `${Math.round((grouped.grandTotal.shippedQty / grouped.grandTotal.orderedQty) * 100)}%` : "—",
      },
      fileName: reportFileName(org, "Executive Business Report", periodLabel, "pdf"),
    });
  }

  const donutData = (bands?.bands || []).filter(b => b.poCount > 0).map(b => ({ name: b.label, value: b.poCount, fill: b.hex }));

  return (
    <div className="rc-page">
      <ReportHeader
        org={org}
        title="Executive Dashboard"
        subtitle="Whole-business position — order book, shipment progress, delivery performance and what needs attention"
        periodLabel={periodLabel}
        dateBasisLabel={dateBasisLabel}
        generatedAt={generatedAt}
        generatedBy={profile?.full_name}
        filterLabels={filterLabels}
        recordCount={summary?.orderLineCount}
        recordNoun="PO lines"
        right={<>
          <button className="btn-outline" onClick={openPdf} disabled={!summary}>Preview report</button>
          <button className="btn-amber" onClick={openExcel} disabled={!summary}>Export Excel</button>
          <button className="btn-outline" onClick={openPdf} disabled={!summary}>Export PDF</button>
        </>}
      />

      <DataIntegrityNotice integrity={data?.integrity} />
      {error && <div className="bk-note warn" style={{ marginBottom: 16 }}>{error}</div>}

      <ReportFilterBar
        filters={filters} onFilters={onFiltersChange}
        period={period} onPeriod={onPeriodChange}
        options={options} seasons={seasons}
        groupBy={groupBy} onGroupBy={setGroupBy}
        groupBy2={groupBy2} onGroupBy2={setGroupBy2}
        metric={metric} onMetric={setMetric}
        topN={topN} onTopN={setTopN}
        onGenerate={generate} loading={loading} dirty={dirty}
      />

      {loading && !summary && <div className="rc-card">Loading business data…</div>}

      {summary && (
        <>
          <div className="kpi-band">
            <KpiTile accent label="Total business" value={fmtNum(summary.orderedQty)} sub={`${fmtMoney(summary.orderValue)} · ${summary.poCount} POs · ${summary.styleCount} styles`} />
            <KpiTile label="Open order book" value={fmtNum(summary.open.qty)} sub={`${fmtMoney(summary.open.value)} across ${summary.open.count} PO lines`} />
            <KpiTile label="Shipped" value={fmtNum(summary.shipped.qty)} sub={`${fmtMoney(summary.shipped.value)} across ${summary.shipped.count} PO lines`} />
            <KpiTile label="Shipment completion" value={`${summary.shipmentPct}%`} sub={`${fmtNum(summary.balanceQty)} pcs still to ship`} />
            <KpiTile label="On-time delivery" value={onTimePct == null ? "—" : `${onTimePct.toFixed(1)}%`} sub={bands ? `${bands.totals.poCount} POs compared · ${bands.notComparable} not yet comparable` : ""} />
            <KpiTile label="Avg short-ship" value={shortShip?.avgShortPct == null ? "—" : `${shortShip.avgShortPct}%`} sub={shortShip ? `${shortShip.partiallyShippedCount} of ${shortShip.shippedOrderCount} shipped POs short` : ""} />
            <KpiTile label="Needs attention" value={attention.length} sub={`${attention.filter(a => a.severity === "critical").length} critical · ${attention.filter(a => a.severity === "warn").length} warning`} />
          </div>

          <div className="rc-grid-2" style={{ marginBottom: 18 }}>
            {/* --- trend ------------------------------------------------- */}
            <div className="rc-card">
              <div className="rc-card-head">
                <span className="rc-card-title">Monthly order book vs shipped</span>
                <div className="seg" style={{ marginLeft: "auto" }}>
                  <button className={trendMetric === "qty" ? "active" : ""} onClick={() => setTrendMetric("qty")}>Quantity</button>
                  <button className={trendMetric === "value" ? "active" : ""} onClick={() => setTrendMetric("value")}>Value</button>
                </div>
              </div>
              <p className="muted-sm" style={{ marginTop: -6, marginBottom: 10 }}>
                Ordered is placed in the month of its ETD (what was <em>due</em>); shipped is placed in the month the goods actually left. One scale, one unit — never two axes.
              </p>
              {trend.length === 0 ? (
                <p className="muted-sm" style={{ padding: "40px 0", textAlign: "center" }}>No months in this period.</p>
              ) : (
                <div style={{ height: 260 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={trend} margin={{ top: 4, right: 8, bottom: 0, left: 4 }}>
                      <CartesianGrid stroke="#EFEBE3" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={{ stroke: "#E7E2D8" }} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={false} tickLine={false}
                        tickFormatter={v => trendMetric === "value" ? `$${(v / 1000).toFixed(0)}k` : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v} />
                      <Tooltip
                        formatter={(v, n) => [trendMetric === "value" ? fmtMoney2(v) : `${fmtNum(v)} pcs`, n]}
                        contentStyle={{ borderRadius: 8, border: "1px solid #E7E2D8", fontSize: 12 }} />
                      <Legend wrapperStyle={{ fontSize: 11.5 }} />
                      <Bar name="Ordered (due)" dataKey={trendMetric === "value" ? "orderValue" : "orderedQty"} fill={SERIES_PLANNED} radius={[4, 4, 0, 0]} maxBarSize={26} />
                      <Bar name="Shipped (actual)" dataKey={trendMetric === "value" ? "shippedValue" : "shippedQty"} fill={SERIES_ACTUAL} radius={[4, 4, 0, 0]} maxBarSize={26} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              )}
            </div>

            {/* --- on-time donut ----------------------------------------- */}
            <div className="rc-card">
              <div className="rc-card-head">
                <span className="rc-card-title">Delivery performance</span>
                <span className="rc-card-note">share of compared POs</span>
              </div>
              {donutData.length === 0 ? (
                <p className="muted-sm" style={{ padding: "40px 0", textAlign: "center" }}>No comparable POs in this period.</p>
              ) : (
                <>
                  <div style={{ height: 200 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={donutData} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="88%" paddingAngle={1} stroke="#fff" strokeWidth={2}>
                          {donutData.map(d => <Cell key={d.name} fill={d.fill} />)}
                        </Pie>
                        <Tooltip formatter={(v, n) => [`${v} PO${v === 1 ? "" : "s"}`, n]} contentStyle={{ borderRadius: 8, border: "1px solid #E7E2D8", fontSize: 12 }} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <table className="rc-table" style={{ marginTop: 6 }}>
                    <tbody>
                      {bands.bands.map(b => (
                        <tr key={b.key}>
                          <td style={{ padding: "7px 4px" }}><span className="rc-swatch" style={{ background: b.hex }} />{b.label}</td>
                          <td className="num" style={{ padding: "7px 4px" }}>{b.poCount}</td>
                          <td className="num" style={{ padding: "7px 4px" }}>{b.pctOfPos.toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td style={{ padding: "8px 4px" }}>Total compared</td>
                        <td className="num" style={{ padding: "8px 4px" }}>{bands.totals.poCount}</td>
                        <td className="num" style={{ padding: "8px 4px" }}>{bands.totals.poCount ? "100.0%" : "—"}</td>
                      </tr>
                    </tfoot>
                  </table>
                </>
              )}
            </div>
          </div>

          {/* --- grouped business table with drill-down ------------------ */}
          <div className="rc-card no-pad" style={{ marginBottom: 18 }}>
            <div className="rc-card-head" style={{ padding: "18px 18px 0", marginBottom: 10 }}>
              <span className="rc-card-title">
                Business by {grouped.dimensionLabel}{grouped.dimension2Label ? `, then by ${grouped.dimension2Label}` : ""}
              </span>
              <span className="rc-card-note">
                {grouped.dimension2Label ? "click a row to drill down · " : ""}
                {grouped.truncated ? `top ${grouped.rows.length} shown, ${grouped.hiddenCount} more in the total` : `${grouped.rows.length} groups`}
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
                          <td className="strong">
                            {hasChildren && <span className="twist">{isOpen ? "▾" : "▸"}</span>}{r.label}
                          </td>
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
                  {grouped.rows.length === 0 && <tr><td colSpan={8} className="empty-row">No orders match these filters.</td></tr>}
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

          {/* --- needs attention ----------------------------------------- */}
          <div className="rc-card no-pad">
            <div className="rc-card-head" style={{ padding: "18px 18px 0", marginBottom: 10 }}>
              <span className="rc-card-title">Needs attention</span>
              <span className="rc-card-note">open orders past or near their ETD, worst first — the same rule the alerts will use</span>
            </div>
            {attention.length === 0 ? (
              <p className="muted-sm" style={{ padding: "0 18px 18px" }}>Nothing overdue or at risk in this selection.</p>
            ) : (
              <div className="rc-scroll">
                <table className="rc-table">
                  <thead>
                    <tr>
                      <th>Severity</th><th>PO</th><th>Style</th><th>Factory</th><th>Merchandiser</th>
                      <th>ETD</th><th style={{ textAlign: "right" }}>Ordered</th>
                      <th style={{ textAlign: "right" }}>Balance</th><th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attention.slice(0, 150).map(a => (
                      <tr key={a.order.id}>
                        <td><span className={"rc-badge " + (a.severity === "critical" ? "bad" : "neutral")}>{a.severity === "critical" ? "● Critical" : "▲ Warning"}</span></td>
                        <td className="strong mono">{a.order.po_prefix}{a.order.po_number}</td>
                        <td>{a.order.style}</td>
                        <td>{a.order.factories?.name || "Unassigned"}</td>
                        <td>{a.order.profiles?.full_name || "Unassigned"}</td>
                        <td className="mono">{fmtCompact(a.order.revised_etd || a.order.etd, dateFormat)}</td>
                        <td className="num">{fmtNum(a.orderedQty)}</td>
                        <td className="num">{fmtNum(a.balanceQty)}</td>
                        <td style={{ color: "var(--pei-muted)" }}>{a.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={6}>Total needing attention{attention.length > 150 ? ` (showing first 150 of ${attention.length})` : ""}</td>
                      <td className="num">{fmtNum(attention.reduce((s, a) => s + a.orderedQty, 0))}</td>
                      <td className="num">{fmtNum(attention.reduce((s, a) => s + a.balanceQty, 0))}</td>
                      <td>{attention.filter(a => a.severity === "critical").length} critical</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {excelSheets && (
        <ExcelPreviewModal
          title={`Executive Business Report — ${periodLabel}`}
          subtitle={[org?.company_name, org?.branch].filter(Boolean).join(" · ")}
          meta={filterLabels.join(" · ")}
          sheets={excelSheets}
          fileName={reportFileName(org, "Executive Business Report", periodLabel, "xlsx")}
          onClose={() => setExcelSheets(null)}
        />
      )}
      {pdfDescriptor && <ReportPreviewModal descriptor={pdfDescriptor} onClose={() => setPdfDescriptor(null)} />}
    </div>
  );
}
