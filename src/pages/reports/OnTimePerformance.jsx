import React, { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { fmtCompact } from "../../lib/dateFormat.js";
import { getFilterOptions } from "../../lib/ordersApi.js";
import {
  buildReportDataset, computeOnTimeBands, delayedOrderRows, seasonsIn,
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

/* On-Time Performance — rebuilt to the Shipment Control prototype's layout.

   Two deliberate structural differences from the old KPI-card version of
   this report:

   1. THE TOTAL IS THE LAST LINE OF THE TABLE. Previously the grand totals
      sat in KPI cards above the chart, which reads as a headline rather
      than as the sum of what's underneath it. Every table on this screen
      now closes with a real <tfoot> total, and the same totals row is
      carried into the Excel sheet and the PDF, so all three agree.

   2. NOTHING EXPORTS ON CLICK. "Export Excel" opens the workbook as a
      browser table to read or copy; "Export PDF" opens the document as an
      on-screen page. The file is written only if the user then asks for
      it. */

const EMPTY_FILTERS = {
  dateBasis: "etd", factoryCode: "", merchandiserId: "", customerCode: "",
  productGroupCode: "", labelCode: "", divisionCode: "", businessUnitCode: "",
  season: "", status: "", style: "", po: "",
};

function fmtNum(n) { return n == null ? "—" : Math.round(n).toLocaleString("en-US"); }
function fmtMoney(n) { return n == null ? "—" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function fmtPct(n) { return n == null ? "—" : `${n.toFixed(1)}%`; }

export default function OnTimePerformance() {
  const ctx = useOutletContext() || {};
  const { dateFormat, profile } = ctx;

  const [org, setOrg] = useState(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [period, setPeriod] = useState(defaultPeriod());
  const [dimension, setDimension] = useState("factory");
  const [dimension2, setDimension2] = useState("");
  const [metric, setMetric] = useState("orderedQty");
  const [topN, setTopN] = useState("");
  const [dirty, setDirty] = useState(false);

  const [applied, setApplied] = useState(null);   // the filters the shown report was actually built from
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [generatedAt, setGeneratedAt] = useState(null);
  const [options, setOptions] = useState({ factories: [] });
  const [showExcel, setShowExcel] = useState(false);
  const [showPdf, setShowPdf] = useState(false);

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

  // Runs once on mount so the screen is never an empty shell -- after
  // that it is strictly driven by the Generate report button, matching
  // the prototype's explicit "choose a period, then generate" flow.
  useEffect(() => { generate(); /* eslint-disable-next-line */ }, []);

  const band = data ? computeOnTimeBands(data.orders, data.shipmentSummaryByOrder, dimension) : null;
  const seasons = data ? seasonsIn(data.orders) : [];
  const dateBasisLabel = (DATE_BASIS_OPTIONS.find(d => d[0] === (applied?.dateBasis || "etd")) || [])[1];
  const filterLabels = applied ? activeFilterLabels(applied, options, band?.dimensionLabel) : [];
  const delayed = band ? delayedOrderRows(band) : [];
  const periodLabel = applied?.periodLabel || "";
  const onTimePct = band && band.totals.poCount ? (band.bands[0].poCount / band.totals.poCount) * 100 : null;
  const generatedLine = generatedAt
    ? `${band?.totals.poCount ?? 0} POs compared · on-time = Actual ETD on or before PO ETD · ${periodLabel}`
    : "";

  /* One descriptor, three destinations: the on-screen table, the Excel
     sheet and the PDF document all read from these same rows/totals. */
  const bandRows = (band?.bands || []).map(b => ({
    Status: b.label,
    "No. of POs": b.poCount,
    "% of POs": Number(b.pctOfPos.toFixed(1)),
    "Ship Qty": b.shipQty,
    "Ship Value": Number(b.shipValue.toFixed(2)),
  }));
  const bandTotals = band ? {
    Status: "Total",
    "No. of POs": band.totals.poCount,
    "% of POs": band.totals.poCount ? 100 : 0,
    "Ship Qty": band.totals.shipQty,
    "Ship Value": Number(band.totals.shipValue.toFixed(2)),
  } : null;

  const vendorRows = (band?.byVendor || []).map(v => ({
    [band.dimensionLabel]: v.label,
    "On-time": v.ontime, "≤ 1 week": v.w1, "1–2 weeks": v.w2, "> 2 weeks": v.late,
    "Total POs": v.total, "On-time %": v.onTimePct, "Ship Qty": v.shipQty,
    "Ship Value": Number(v.shipValue.toFixed(2)),
  }));
  const vendorTotals = band ? {
    [band.dimensionLabel]: "Total",
    "On-time": band.bands[0].poCount, "≤ 1 week": band.bands[1].poCount,
    "1–2 weeks": band.bands[2].poCount, "> 2 weeks": band.bands[3].poCount,
    "Total POs": band.totals.poCount,
    "On-time %": band.totals.poCount ? Number(((band.bands[0].poCount / band.totals.poCount) * 100).toFixed(1)) : 0,
    "Ship Qty": band.totals.shipQty, "Ship Value": Number(band.totals.shipValue.toFixed(2)),
  } : null;

  const delayedRows = delayed.map(r => ({
    PO: `${r.order.po_prefix}${r.order.po_number}`,
    Style: r.order.style,
    Factory: r.order.factories?.name || "Unassigned",
    Merchandiser: r.order.profiles?.full_name || "Unassigned",
    "PO ETD": r.order.etd || "",
    "Actual ETD": data.shipmentSummaryByOrder.get(r.order.id)?.latestActualEtd || "",
    "Days late": r.delayDays,
    Band: band.bands.find(b => b.key === r.band)?.label || "",
    "Ship Qty": r.shipQty,
  }));

  const excelSheets = band ? [
    { name: "Delay Bands", rows: bandRows, totals: bandTotals },
    { name: `By ${band.dimensionLabel}`, rows: vendorRows, totals: vendorTotals },
    { name: "Delayed POs", rows: delayedRows },
  ] : [];

  const pdfDescriptor = band ? {
    companyName: [org?.company_name, org?.branch].filter(Boolean).join(" — "),
    reportName: `On-Time Shipment Performance — ${periodLabel}`,
    periodLabel: `Report Period: ${periodLabel} (basis: ${dateBasisLabel})`,
    filterLabels: [...filterLabels, "Measured as: Actual ETD vs PO ETD"],
    kpis: [
      { label: "On-time %", value: onTimePct == null ? "—" : `${onTimePct.toFixed(1)}%` },
      { label: "POs compared", value: band.totals.poCount },
      { label: "Delayed POs", value: band.totals.poCount - band.bands[0].poCount },
      { label: "Ship Qty", value: fmtNum(band.totals.shipQty) },
      { label: "Ship Value", value: fmtMoney(band.totals.shipValue) },
    ],
    columns: [
      { header: "Status", key: "status", align: "left" },
      { header: "No. of POs", key: "poCount", align: "right" },
      { header: "% of POs", key: "pct", align: "right" },
      { header: "Ship Qty", key: "qty", align: "right" },
      { header: "Ship Value", key: "value", align: "right" },
    ],
    rows: band.bands.map(b => ({
      status: b.label, poCount: b.poCount, pct: `${b.pctOfPos.toFixed(1)}%`,
      qty: fmtNum(b.shipQty), value: fmtMoney(b.shipValue),
    })),
    totalsRow: {
      status: "Total", poCount: band.totals.poCount, pct: band.totals.poCount ? "100.0%" : "—",
      qty: fmtNum(band.totals.shipQty), value: fmtMoney(band.totals.shipValue),
    },
    fileName: reportFileName(org, "On-Time Performance", periodLabel, "pdf"),
  } : null;

  const donutData = (band?.bands || []).filter(b => b.poCount > 0).map(b => ({ name: b.label, value: b.poCount, fill: b.hex }));

  return (
    <div className="rc-page">
      <ReportHeader
        org={org}
        title="On-Time Performance"
        subtitle={`Actual ETD against PO ETD, by delay band and by ${band?.dimensionLabel?.toLowerCase() || "factory"}`}
        periodLabel={periodLabel}
        dateBasisLabel={dateBasisLabel}
        generatedAt={generatedAt}
        generatedBy={profile?.full_name}
        filterLabels={filterLabels}
        recordCount={band?.comparedCount}
        recordNoun="POs compared"
        right={<>
          <button className="btn-outline" onClick={() => setShowPdf(true)} disabled={!band}>Preview report</button>
          <button className="btn-amber" onClick={() => setShowExcel(true)} disabled={!band}>Export Excel</button>
          <button className="btn-outline" onClick={() => setShowPdf(true)} disabled={!band}>Export PDF</button>
        </>}
      />

      <DataIntegrityNotice integrity={data?.integrity} />
      {error && <div className="bk-note warn" style={{ marginBottom: 16 }}>{error}</div>}

      <ReportFilterBar
        filters={filters} onFilters={f => { setFilters(f); setDirty(true); }}
        period={period} onPeriod={p => { setPeriod(p); setDirty(true); }}
        options={options} seasons={seasons}
        groupBy={dimension} onGroupBy={setDimension}
        groupBy2={dimension2} onGroupBy2={setDimension2}
        metric={metric} onMetric={setMetric}
        topN={topN} onTopN={setTopN}
        onGenerate={generate} loading={loading} dirty={dirty}
      />

      <p className="muted-sm" style={{ margin: "-6px 2px 16px" }}>
        On-time = Actual ETD on or before PO ETD. Delay bands: up to 1 week, 1–2 weeks, and over 2 weeks late.
        An order's <strong>latest</strong> actual ETD is used, so a PO isn't judged complete until its final partial shipment leaves.
        The <strong>Group by</strong> control above drives the breakdown table below — factory, merchandiser, customer, product group, label, business unit, season or style.
      </p>

      {band && (
        <>
          <div className="rc-grid-2" style={{ marginBottom: 18 }}>
            {/* --- delay-band table, total on the bottom line ------------- */}
            <div className="rc-card">
              <div style={{ fontSize: 15, fontWeight: 650, marginBottom: 2 }}>On-Time Shipment Performance — {periodLabel}</div>
              <div style={{ fontSize: 11.5, color: "var(--pei-muted)", marginBottom: 14, lineHeight: 1.5 }}>{generatedLine}</div>
              <table className="rc-table">
                <thead>
                  <tr>
                    <th>Status</th><th style={{ textAlign: "right" }}>No. of POs</th><th style={{ textAlign: "right" }}>% of POs</th>
                    <th style={{ textAlign: "right" }}>Ship Qty</th><th style={{ textAlign: "right" }}>Ship Value</th>
                  </tr>
                </thead>
                <tbody>
                  {band.bands.map(b => (
                    <tr key={b.key}>
                      <td><span className="rc-swatch" style={{ background: b.hex }} />{b.label}</td>
                      <td className="num">{b.poCount}</td>
                      <td className="num">{fmtPct(b.pctOfPos)}</td>
                      <td className="num">{fmtNum(b.shipQty)}</td>
                      <td className="num">{fmtMoney(b.shipValue)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td>Total</td>
                    <td className="num">{band.totals.poCount}</td>
                    <td className="num">{band.totals.poCount ? "100.0%" : "—"}</td>
                    <td className="num">{fmtNum(band.totals.shipQty)}</td>
                    <td className="num">{fmtMoney(band.totals.shipValue)}</td>
                  </tr>
                </tfoot>
              </table>
              {band.notComparable > 0 && (
                <p style={{ fontSize: 11.5, color: "var(--pei-muted)", marginTop: 12 }}>
                  {band.notComparable} order{band.notComparable === 1 ? "" : "s"} in this period {band.notComparable === 1 ? "is" : "are"} not yet comparable — no actual ETD recorded, or no PO ETD set. They are excluded from the percentages above rather than counted as on-time.
                </p>
              )}
            </div>

            {/* --- donut ------------------------------------------------- */}
            <div className="rc-card">
              <div className="rc-card-head">
                <span className="rc-card-title">On-time vs delayed</span>
                <span className="rc-card-note">share of POs</span>
              </div>
              {donutData.length === 0 ? (
                <p className="muted-sm" style={{ padding: "40px 0", textAlign: "center" }}>No comparable POs in this period.</p>
              ) : (
                <>
                  <div style={{ height: 230 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={donutData} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="88%" paddingAngle={1} stroke="#fff" strokeWidth={2}>
                          {donutData.map(d => <Cell key={d.name} fill={d.fill} />)}
                        </Pie>
                        <Tooltip formatter={(v, n) => [`${v} PO${v === 1 ? "" : "s"}`, n]} />
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="rc-legend">
                    {band.bands.map(b => (
                      <span key={b.key}><span className="rc-swatch" style={{ background: b.hex }} />{b.label} <strong>{b.poCount}</strong></span>
                    ))}
                  </div>
                  <div style={{ textAlign: "center", marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--pei-border-soft)" }}>
                    <div style={{ fontSize: 30, fontWeight: 700, lineHeight: 1 }}>{onTimePct == null ? "—" : `${onTimePct.toFixed(1)}%`}</div>
                    <div style={{ fontSize: 11.5, color: "var(--pei-muted)", marginTop: 4 }}>on-time across {band.totals.poCount} compared PO{band.totals.poCount === 1 ? "" : "s"}</div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* --- by vendor / factory ------------------------------------- */}
          <div className="rc-card no-pad" style={{ marginBottom: 18 }}>
            <div className="rc-card-head" style={{ padding: "18px 18px 0", marginBottom: 10 }}>
              <span className="rc-card-title">By {band.dimensionLabel.toLowerCase()}</span>
              <span className="rc-card-note">where the delays are concentrated</span>
            </div>
            <div className="rc-scroll">
              <table className="rc-table">
                <thead>
                  <tr>
                    <th>{band.dimensionLabel}</th>
                    <th style={{ textAlign: "right" }}>On-time</th><th style={{ textAlign: "right" }}>≤ 1 week</th>
                    <th style={{ textAlign: "right" }}>1–2 weeks</th><th style={{ textAlign: "right" }}>&gt; 2 weeks</th>
                    <th style={{ textAlign: "right" }}>Total POs</th><th style={{ textAlign: "right" }}>Ship Qty</th>
                    <th style={{ textAlign: "right" }}>On-time %</th>
                  </tr>
                </thead>
                <tbody>
                  {band.byVendor.map(v => (
                    <tr key={v.key}>
                      <td className="strong">{v.label}</td>
                      <td className="num">{v.ontime}</td><td className="num">{v.w1}</td>
                      <td className="num">{v.w2}</td><td className="num">{v.late}</td>
                      <td className="num">{v.total}</td><td className="num">{fmtNum(v.shipQty)}</td>
                      <td className="num">
                        <span className={"rc-badge " + (v.onTimePct >= 80 ? "good" : v.onTimePct >= 50 ? "neutral" : "bad")}>
                          {v.onTimePct >= 80 ? "↑" : v.onTimePct >= 50 ? "•" : "↓"} {v.onTimePct}% on-time
                        </span>
                      </td>
                    </tr>
                  ))}
                  {band.byVendor.length === 0 && <tr><td colSpan={8} className="empty-row">No comparable POs for this period.</td></tr>}
                </tbody>
                {band.byVendor.length > 0 && (
                  <tfoot>
                    <tr>
                      <td>Total</td>
                      <td className="num">{band.bands[0].poCount}</td><td className="num">{band.bands[1].poCount}</td>
                      <td className="num">{band.bands[2].poCount}</td><td className="num">{band.bands[3].poCount}</td>
                      <td className="num">{band.totals.poCount}</td><td className="num">{fmtNum(band.totals.shipQty)}</td>
                      <td className="num">{onTimePct == null ? "—" : `${onTimePct.toFixed(1)}%`}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>

          {/* --- the actual delayed POs --------------------------------- */}
          {delayed.length > 0 && (
            <div className="rc-card no-pad">
              <div className="rc-card-head" style={{ padding: "18px 18px 0", marginBottom: 10 }}>
                <span className="rc-card-title">Delayed POs</span>
                <span className="rc-card-note">{delayed.length} PO{delayed.length === 1 ? "" : "s"}, latest actual ETD after PO ETD — worst first</span>
              </div>
              <div className="rc-scroll">
                <table className="rc-table">
                  <thead>
                    <tr>
                      <th>PO</th><th>Style</th><th>Factory</th><th>Merchandiser</th>
                      <th>PO ETD</th><th>Actual ETD</th><th style={{ textAlign: "right" }}>Days late</th>
                      <th style={{ textAlign: "right" }}>Ship Qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {delayed.slice(0, 200).map(r => (
                      <tr key={r.order.id}>
                        <td className="strong mono">{r.order.po_prefix}{r.order.po_number}</td>
                        <td>{r.order.style}</td>
                        <td>{r.order.factories?.name || "Unassigned"}</td>
                        <td>{r.order.profiles?.full_name || "Unassigned"}</td>
                        <td className="mono">{fmtCompact(r.order.etd, dateFormat)}</td>
                        <td className="mono">{fmtCompact(data.shipmentSummaryByOrder.get(r.order.id)?.latestActualEtd, dateFormat)}</td>
                        <td className="num"><span className="rc-badge bad">+{r.delayDays}d</span></td>
                        <td className="num">{fmtNum(r.shipQty)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={6}>Total delayed {delayed.length > 200 ? `(showing first 200 of ${delayed.length})` : ""}</td>
                      <td className="num">{delayed.length} POs</td>
                      <td className="num">{fmtNum(delayed.reduce((s, r) => s + r.shipQty, 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {showExcel && (
        <ExcelPreviewModal
          title={`On-Time Shipment Performance — ${periodLabel}`}
          subtitle={[org?.company_name, org?.branch].filter(Boolean).join(" · ")}
          meta={generatedLine}
          sheets={excelSheets}
          fileName={reportFileName(org, "On-Time Performance", periodLabel, "xlsx")}
          onClose={() => setShowExcel(false)}
        />
      )}
      {showPdf && <ReportPreviewModal descriptor={pdfDescriptor} onClose={() => setShowPdf(false)} />}
    </div>
  );
}
