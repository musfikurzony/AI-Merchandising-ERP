import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { getFilterOptions } from "../../lib/ordersApi.js";
import { buildReportDataset, seasonsIn, GROUP_DIMENSIONS } from "../../lib/reportsApi.js";
import {
  buildSalesMatrix, matrixDateRange, matrixToSheet, fiscalYearLabelFor,
  currentFiscalYear, fiscalStartMonthName, scopeLabel, fmtPct,
  SALES_SCOPES, SALES_MEASURES,
} from "../../lib/salesMatrixApi.js";
import { loadOrganization, activeFilterLabels, reportFileName, exportHeaderBlock, formatGeneratedAt } from "../../lib/reportContext.js";
import ReportHeader from "../../components/ReportHeader.jsx";
import DataIntegrityNotice from "../../components/DataIntegrityNotice.jsx";
import ReportFilterBar from "../../components/ReportFilterBar.jsx";
import ExcelPreviewModal from "../../components/ExcelPreviewModal.jsx";
import ReportPreviewModal from "../../components/ReportPreviewModal.jsx";

/* ==========================================================================
   Annual Sales Report — the fiscal year on one page.
   ==========================================================================
   The corporate monthly sheet: twelve fiscal months across, the business
   down the side, a cumulative line under the total, and last year beside
   it. Its own screen rather than a tenth entry in Reports Center, for one
   concrete reason — every other report answers a question about ONE period,
   and this one needs TWO fiscal years loaded at once to draw the comparison
   line. Bolting a second period onto Reports Center's period control would
   have made nine working reports carry a concept only the tenth uses.

   Everything else is shared: the same filter bar, the same header, the same
   integrity notice, the same preview-first exports, and — the part that
   matters — the same `orderMetrics()` behind every figure. See
   lib/salesMatrixApi.js for why "Open + Shipped" cannot double count.

   The report is WIDE by nature. Three things keep it readable rather than
   pretending it is narrow:
     - the dimension column is frozen, so a row never loses its name;
     - Quantity / Value / both is a toggle, because 12 months x 2 measures
       is 24 columns and almost nobody wants both at once;
     - the closing block is sticky to the bottom of the scroll area, since
       the cumulative line is the line people came to read.
*/

const EMPTY_FILTERS = {
  dateBasis: "delivery", factoryCode: "", merchandiserId: "", customerCode: "",
  productGroupCode: "", labelCode: "", divisionCode: "", businessUnitCode: "",
  season: "", status: "", style: "", po: "",
};

function fmtQty(n) { return !n ? "—" : Math.round(n).toLocaleString("en-US"); }
function fmtVal(n) { return !n ? "—" : `$${Math.round(n).toLocaleString("en-US")}`; }

export default function SalesMatrix() {
  const ctx = useOutletContext() || {};
  const { profile } = ctx;

  const [org, setOrg] = useState(null);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [fiscalYear, setFiscalYear] = useState(currentFiscalYear());
  const [scope, setScope] = useState("both");
  const [measure, setMeasure] = useState("qty");
  const [dimension, setDimension] = useState("factory");
  const [topN, setTopN] = useState("");
  const [dirty, setDirty] = useState(false);

  const [applied, setApplied] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [generatedAt, setGeneratedAt] = useState(null);
  const [options, setOptions] = useState({ factories: [] });
  const [showExcel, setShowExcel] = useState(false);
  const [showPdf, setShowPdf] = useState(false);
  const scrollRef = useRef(null);

  /* The five sticky closing rows stack on multiples of one row's height.
     That height is measured from what the browser actually rendered rather
     than assumed, so a longer label, a different font size or a zoomed
     window cannot make the rows overlap and hide the cumulative line. */
  const measureFooter = useCallback(() => {
    const el = scrollRef.current;
    const row = el?.querySelector("tfoot tr:last-child");
    if (!el || !row) return;
    const h = Math.round(row.getBoundingClientRect().height);
    if (h > 0) el.style.setProperty("--sm-fh", `${h}px`);
  }, []);

  useEffect(() => {
    loadOrganization().then(setOrg);
    getFilterOptions().then(setOptions).catch(() => {});
  }, []);

  async function generate() {
    /* Two fiscal years in one query. Loading the selected year and then the
       prior one separately would double the round trip for data the second
       call would largely re-fetch anyway. */
    const range = matrixDateRange(fiscalYear);
    const query = { ...filters, ...range };
    setLoading(true); setError(null);
    try {
      const result = await buildReportDataset(query);
      setData(result);
      setApplied({ ...query, fiscalYear });
      setGeneratedAt(new Date());
      setDirty(false);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }

  useEffect(() => { generate(); /* eslint-disable-next-line */ }, []);

  useLayoutEffect(measureFooter);
  useEffect(() => {
    window.addEventListener("resize", measureFooter);
    return () => window.removeEventListener("resize", measureFooter);
  }, [measureFooter]);

  /* Scope, dimension, measure and Top N re-shape data already in hand, so
     they apply instantly. Only the filters and the fiscal year re-query —
     the same distinction Reports Center states on screen. */
  const matrix = useMemo(() => {
    if (!data || !applied) return null;
    return buildSalesMatrix(data, {
      fiscalYear: applied.fiscalYear,
      dimension, scope,
      topN: topN ? Number(topN) : null,
    });
  }, [data, applied, dimension, scope, topN]);

  const seasons = data ? seasonsIn(data.orders) : [];
  const filterLabels = applied ? activeFilterLabels(applied, options, matrix?.dimensionLabel) : [];
  const periodLabel = applied ? fiscalYearLabelFor(applied.fiscalYear) : "";

  const showQty = measure === "qty" || measure === "both";
  const showVal = (measure === "value" || measure === "both") && !!matrix?.hasValue;

  /* One shaping function, three destinations — screen, Excel, PDF. */
  const sheet = useMemo(() => (matrix ? matrixToSheet(matrix, measure) : null), [matrix, measure]);

  function openExcel() {
    if (!matrix || !sheet) return;
    setShowExcel(true);
  }

  const excelSheets = useMemo(() => {
    if (!matrix || !sheet) return [];
    const body = sheet.rows.slice(0, sheet.bodyCount);
    const foot = sheet.rows.slice(sheet.bodyCount);
    return [
      {
        name: "Sales Matrix",
        rows: [...body, ...foot],
        header: exportHeaderBlock({
          org, reportName: `Annual Sales Report — ${scopeLabel(scope)}`,
          reportType: "Fiscal Year Sales Matrix",
          periodLabel, dateBasisLabel: "Delivery Date (revised if any)",
          filters: applied || {}, options,
          viewLabel: `By ${matrix.dimensionLabel}`,
          generatedAt, generatedBy: profile?.full_name || "",
        }),
      },
      {
        name: "Report Info",
        rows: [
          { Field: "Report", Value: "Annual Sales Report (fiscal year matrix)" },
          { Field: "Fiscal year", Value: periodLabel },
          { Field: "Fiscal year starts", Value: fiscalStartMonthName() },
          { Field: "Scope", Value: scopeLabel(scope) },
          { Field: "Grouped by", Value: matrix.dimensionLabel },
          { Field: "Measure", Value: (SALES_MEASURES.find(m => m[0] === measure) || [])[1] },
          { Field: "Open orders counted in", Value: "the month of their latest committed ETD (revised if any)" },
          { Field: "Shipped orders counted in", Value: "the month they actually shipped" },
          { Field: "Cancelled orders", Value: "excluded" },
          { Field: "Orders with no date", Value: String(matrix.skippedNoDate) },
          { Field: "Generated", Value: formatGeneratedAt(generatedAt || new Date()) },
          { Field: "Generated by", Value: profile?.full_name || "" },
          ...filterLabels.map((f, i) => ({ Field: `Filter ${i + 1}`, Value: f })),
        ],
      },
    ];
  }, [matrix, sheet, org, periodLabel, applied, options, generatedAt, profile, scope, measure, filterLabels]);

  /* The PDF takes ONE measure, always. Twenty-four numeric columns do not
     fit A4 landscape at a legible size, and a report that has to be
     magnified to be read is not a report. */
  const pdfMeasure = measure === "both" ? "qty" : measure;
  const pdfDescriptor = useMemo(() => {
    if (!matrix) return null;
    const s = matrixToSheet(matrix, pdfMeasure);
    const keys = Object.keys(s.rows[0] || {});
    return {
      companyName: [org?.company_name, org?.branch].filter(Boolean).join(" — ") || undefined,
      reportName: `Annual Sales Report — ${scopeLabel(scope)} (${pdfMeasure === "value" ? "Value" : "Quantity"})`,
      periodLabel,
      filterLabels: [`By ${matrix.dimensionLabel}`, ...filterLabels],
      kpis: [
        { label: "Total qty", value: fmtQty(matrix.grand.qty) },
        ...(matrix.hasValue ? [{ label: "Total value", value: fmtVal(matrix.grand.value) }] : []),
        { label: `vs FY${matrix.fiscalYear - 1}`, value: fmtPct(matrix.variance[11].qty) },
        { label: "PO lines", value: matrix.grand.poCount.toLocaleString() },
      ],
      columns: keys.map((k, i) => ({ key: k, header: k, align: i === 0 ? "left" : "right" })),
      rows: s.rows.slice(0, s.bodyCount),
      footRows: s.rows.slice(s.bodyCount),
      fileName: reportFileName(org, "Annual Sales Report", periodLabel, "pdf"),
    };
  }, [matrix, org, periodLabel, filterLabels, scope, pdfMeasure]);

  const yearChoices = [currentFiscalYear() + 1, currentFiscalYear(), currentFiscalYear() - 1, currentFiscalYear() - 2, currentFiscalYear() - 3];

  return (
    <div className="page">
      <ReportHeader
        org={org}
        title="Annual Sales Report"
        subtitle={matrix ? `${scopeLabel(scope)} · by ${matrix.dimensionLabel} · twelve fiscal months with a cumulative and last-year comparison` : "Fiscal year sales matrix"}
        periodLabel={periodLabel}
        dateBasisLabel="Delivery Date (revised if any)"
        filterLabels={filterLabels}
        generatedAt={generatedAt}
        generatedBy={profile?.full_name}
        recordCount={matrix?.grand.poCount}
        recordNoun="PO lines"
      />

      <DataIntegrityNotice integrity={data?.integrity} />

      <div className="sm-controls">
        <div className="sm-group">
          <label>Fiscal year</label>
          <select value={fiscalYear} onChange={e => { setFiscalYear(Number(e.target.value)); setDirty(true); }}>
            {yearChoices.map(y => <option key={y} value={y}>{fiscalYearLabelFor(y)}</option>)}
          </select>
          <span className="sm-hint">starts in {fiscalStartMonthName()}</span>
        </div>

        <div className="sm-group">
          <label>Show</label>
          <div className="sm-seg">
            {SALES_SCOPES.map(([k, l, why]) => (
              <button key={k} title={why} className={scope === k ? "on" : ""} onClick={() => setScope(k)}>{l}</button>
            ))}
          </div>
        </div>

        <div className="sm-group">
          <label>Measure</label>
          <div className="sm-seg">
            {SALES_MEASURES.map(([k, l]) => (
              <button key={k} className={measure === k ? "on" : ""} onClick={() => setMeasure(k)}
                disabled={k !== "qty" && !matrix?.hasValue}>{l}</button>
            ))}
          </div>
        </div>

        <div className="sm-group">
          <label>Rows</label>
          <select value={dimension} onChange={e => setDimension(e.target.value)}>
            {GROUP_DIMENSIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select value={topN} onChange={e => setTopN(e.target.value)} title="Collapse the tail into one 'Other' row">
            <option value="">All rows</option>
            <option value="10">Top 10</option>
            <option value="20">Top 20</option>
            <option value="30">Top 30</option>
          </select>
        </div>

        <span className="spacer" />
        <button className="btn-outline" onClick={openExcel} disabled={!matrix}>Export Excel</button>
        <button className="btn-outline" onClick={() => setShowPdf(true)} disabled={!matrix}>Export PDF</button>
      </div>

      <ReportFilterBar
        filters={filters} onFilters={f => { setFilters(f); setDirty(true); }}
        options={options} seasons={seasons}
        showGrouping={false}
        onGenerate={generate} loading={loading} dirty={dirty}
        hidePeriod
      />

      {error && <div className="rc-error">{error}</div>}
      {!matrix && !loading && <p className="db-empty">Choose a fiscal year and press Generate report.</p>}

      {matrix && !matrix.hasValue && (
        <p className="sm-note">
          Value columns are hidden because FOB is not visible to your account. Quantities are complete.
        </p>
      )}
      {matrix && matrix.skippedNoDate > 0 && (
        <p className="sm-note">
          {matrix.skippedNoDate.toLocaleString()} order{matrix.skippedNoDate === 1 ? " has" : "s have"} no ETD and cannot be placed in a month — excluded from every figure here.
        </p>
      )}

      {matrix && (
        <div className="sm-scroll" ref={scrollRef}>
          <table className="sm-table">
            <thead>
              <tr>
                <th className="sm-dim" rowSpan={measure === "both" ? 2 : 1}>{matrix.dimensionLabel}</th>
                {matrix.months.map(m => (
                  <th key={m.key} className="num" colSpan={measure === "both" ? 2 : 1}>{m.label}</th>
                ))}
                <th className="num sm-total-col" colSpan={measure === "both" ? 2 : 1}>Total</th>
              </tr>
              {measure === "both" && (
                <tr className="sm-sub">
                  {matrix.months.map(m => (
                    <React.Fragment key={m.key}>
                      <th className="num">Qty</th><th className="num">Value</th>
                    </React.Fragment>
                  ))}
                  <th className="num sm-total-col">Qty</th><th className="num sm-total-col">Value</th>
                </tr>
              )}
            </thead>

            <tbody>
              {matrix.rows.map(r => (
                <tr key={r.key}>
                  <td className="sm-dim">{r.label}</td>
                  {r.cells.map((c, i) => (
                    <React.Fragment key={i}>
                      {showQty && <td className="num">{fmtQty(c.qty)}</td>}
                      {showVal && <td className="num money">{fmtVal(c.value)}</td>}
                    </React.Fragment>
                  ))}
                  {showQty && <td className="num sm-total-col">{fmtQty(r.total.qty)}</td>}
                  {showVal && <td className="num sm-total-col money">{fmtVal(r.total.value)}</td>}
                </tr>
              ))}
              {matrix.rows.length === 0 && (
                <tr><td colSpan={99} className="empty-row">No business in {periodLabel} for these filters.</td></tr>
              )}
            </tbody>

            {/* The closing block, in the order a finance reader meets it. */}
            <tfoot>
              <FootRow label={`TOTAL — ${scopeLabel(scope)}`} cells={matrix.total} total={matrix.grand} cls="sm-f0" {...{ showQty, showVal }} />
              <FootRow label="CUMULATIVE (year to date)" cells={matrix.cumulative} total={matrix.cumulative[11]} cls="sm-f1" {...{ showQty, showVal }} />
              <FootRow label={`LAST YEAR (FY${matrix.fiscalYear - 1})`} cells={matrix.lastYear} total={matrix.lastGrand} cls="sm-f2" {...{ showQty, showVal }} />
              <FootRow label="LAST YEAR CUMULATIVE" cells={matrix.lastCumulative} total={matrix.lastCumulative[11]} cls="sm-f3" {...{ showQty, showVal }} />
              <tr className="sm-f4 sm-var">
                <td className="sm-dim">VARIANCE vs LAST YEAR (cumulative)</td>
                {matrix.variance.map((v, i) => (
                  <React.Fragment key={i}>
                    {showQty && <td className={"num " + toneOf(v.qty)}>{fmtPct(v.qty)}</td>}
                    {showVal && <td className={"num " + toneOf(v.value)}>{fmtPct(v.value)}</td>}
                  </React.Fragment>
                ))}
                {showQty && <td className={"num sm-total-col " + toneOf(matrix.variance[11].qty)}>{fmtPct(matrix.variance[11].qty)}</td>}
                {showVal && <td className={"num sm-total-col " + toneOf(matrix.variance[11].value)}>{fmtPct(matrix.variance[11].value)}</td>}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {matrix && matrix.hidden > 0 && (
        <p className="sm-note">The {matrix.hidden} smallest {matrix.dimensionLabel.toLowerCase()} rows are collapsed into “Other”. Their figures are included in every total.</p>
      )}

      {showExcel && (
        <ExcelPreviewModal
          title={`Annual Sales Report — ${scopeLabel(scope)}`}
          subtitle={[org?.company_name, org?.branch].filter(Boolean).join(" — ")}
          meta={`${periodLabel} · by ${matrix.dimensionLabel}`}
          sheets={excelSheets}
          fileName={reportFileName(org, "Annual Sales Report", periodLabel, "xlsx")}
          onClose={() => setShowExcel(false)}
        />
      )}
      {showPdf && <ReportPreviewModal descriptor={pdfDescriptor} onClose={() => setShowPdf(false)} />}
    </div>
  );
}

function toneOf(p) {
  if (p == null) return "";
  return p >= 0 ? "sm-up" : "sm-down";
}

function FootRow({ label, cells, total, cls, showQty, showVal }) {
  return (
    <tr className={cls}>
      <td className="sm-dim">{label}</td>
      {cells.map((c, i) => (
        <React.Fragment key={i}>
          {showQty && <td className="num">{fmtQty(c.qty)}</td>}
          {showVal && <td className="num money">{fmtVal(c.value)}</td>}
        </React.Fragment>
      ))}
      {showQty && <td className="num sm-total-col">{fmtQty(total?.qty)}</td>}
      {showVal && <td className="num sm-total-col money">{fmtVal(total?.value)}</td>}
    </tr>
  );
}
