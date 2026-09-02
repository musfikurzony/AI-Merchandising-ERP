import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import ExcelPreviewModal from "../../components/ExcelPreviewModal.jsx";
import { stamp } from "../../lib/exportPreview.js";
import { getMilestoneTypes, listWorkbenchOrders, listColorWays, listMilestones, getFollowUpColumnPrefs, saveFollowUpColumnPrefs } from "../../lib/workbenchApi.js";
import { fmtCompact } from "../../lib/dateFormat.js";
import { completedLate, lateByDays } from "../../lib/milestoneReminder.js";

/* Real port of v13's actual FollowupReport (confirmed against the real
   source, not the milestone-description guess this replaced): grouped by
   Label, one row per color way, sharing the exact same milestone spec
   (tna_milestone_types / order_milestones) the Workbench uses -- so a
   value entered in either place shows up in both, immediately. The
   printed report uses a leaner default column set than the Workbench
   (confirmed via v13's own REPORT_DEFAULT_KEYS), persisted separately per
   user. Only orders with a factory assigned are shown -- same rule v13
   uses, and the same one `listWorkbenchOrders()` already enforces. */

/* SCREEN widths, measured rather than chosen: each is the rendered width of
   the longest realistic value in that column at 11px, plus cell padding
   ("403 TOTAL ECLIPSE" 113px, a date 53px, a date with its A mark and status
   code 87px). Squeezing these was a mistake in an earlier draft — on screen
   there is horizontal room, and truncating "05/12/26" to "05/12…" to save
   16px helps nobody. The tight PRINT widths are a separate set in base.css,
   because paper is where the space is genuinely scarce. */
const FU_ID_WIDTHS = [36, 63, 69, 129, 56, 56, 69, 69];
const FU_MS_WIDTH = 103;
/* How many milestones fit A4 landscape, from the PRINT widths in base.css:
   1054px usable, 382px of identity columns, 55px each. Stated here so the
   sentence on the sheet and the number in the test come from one place. */
export const FU_A4_MILESTONES = Math.floor((1054 - 382) / 55);

const REPORT_DEFAULT_KEYS = ["fab_ref", "lab_dip", "strike_off", "fab_etd", "fab_inhouse", "fit", "pp", "prod_start", "shade_band", "crd"];

function fmtNum(n) { return n == null ? "—" : Number(n).toLocaleString("en-US"); }

/* A milestone header wraps at its slash or at a space, so "Fabric Strike-off /
   Handloom" becomes two short lines instead of one long one. Returned as
   fragments rather than inserting <br> into a string, so a label containing
   markup characters can never become markup. */
function wrapHeader(label) {
  const parts = String(label).split(/\s*\/\s*/);
  if (parts.length > 1) {
    return parts.map((part, i) => (
      <React.Fragment key={i}>
        {i > 0 && <span className="fu-msh-slash">/</span>}
        <span className="fu-msh-part">{part}</span>
      </React.Fragment>
    ));
  }
  return <span className="fu-msh-part">{label}</span>;
}

/* The printed report asks a different question from the Workbench.

   The Workbench colour is an ACTION reminder — it disappears the moment an
   actual date is entered, because there is nothing left to chase. The report
   is a HISTORICAL record, so a milestone completed after its plan date stays
   marked here: that is the performance fact a manager is reading the sheet to
   find. Same underlying rows, two deliberately different readings, and the
   difference lives in one shared module rather than in two screens' opinions.

   One cell says three things in about nine characters:
     17/05 A     completed on 17 May
     10/06 P     still planned for 10 June
     12/06 A     completed on 12 June, after its plan — printed marked

   Status keeps its own short code so the business field never vanishes from
   the sheet, and it is the SAME stored value the Workbench and the
   notification engine read — abbreviated for width, not reinterpreted. */
/* The five values the app itself stores, plus the synonyms that turn up in
   imported and legacy rows. Grouping "completed"/"approved" with "done" is
   not a reinterpretation: notificationsApi.isApproved() already treats those
   three as the same condition, so the report agrees with the engine rather
   than inventing a mapping of its own. Anything genuinely unrecognised is
   abbreviated, never dropped and never renamed — the sheet shows what is
   stored. */
const STATUS_ALIASES = {
  done: "done", completed: "done", complete: "done", approved: "done",
  ontrack: "onTrack", "on track": "onTrack",
  atrisk: "atRisk", overdue: "atRisk", "at risk": "atRisk",
  critical: "critical", delayed: "critical", late: "critical",
  pending: "pending", open: "pending", "": "pending",
  /* Not offered by the dropdown, but the notification engine acts on both —
     approval_rejected and awaiting_approval look for exactly these — so they
     can arrive from a PLM import and must be readable on the sheet rather
     than shown as a truncated mystery. */
  rejected: "rejected", failed: "rejected", "not approved": "rejected",
  submitted: "submitted", "in review": "submitted", in_review: "submitted",
  sent: "submitted", "awaiting approval": "submitted", "with buyer": "submitted",
};
const STATUS_CODE = { done: "DN", onTrack: "OT", atRisk: "OV", critical: "DL", pending: "PN", rejected: "RJ", submitted: "SB" };
const STATUS_NAME = { done: "Done", onTrack: "On Track", atRisk: "Overdue", critical: "Delayed", pending: "Pending", rejected: "Rejected", submitted: "Submitted / with buyer" };

function normaliseStatus(raw) {
  return STATUS_ALIASES[String(raw ?? "").trim().toLowerCase()] || null;
}
function statusCode(raw) {
  const k = normaliseStatus(raw);
  if (k) return STATUS_CODE[k];
  return String(raw).trim().slice(0, 2).toUpperCase();   // unrecognised: shortened, not reinterpreted
}
function statusName(raw) {
  const k = normaliseStatus(raw);
  return k ? STATUS_NAME[k] : String(raw || "—");
}

function milestoneCell(row, col, milestonesByKey, dateFormat, showStatus) {
  const key = `${row.order.id}|${col.key}|${col.color_level ? row.colorName : ""}`;
  const m = milestonesByKey[key];
  if (!m) return <span className="fu-empty">—</span>;

  if (col.field_type === "text") return m.text_value || <span className="fu-empty">—</span>;
  if (col.field_type === "single") return m.single_value ? fmtCompact(m.single_value, dateFormat) : <span className="fu-empty">—</span>;
  if (col.field_type !== "pds") {
    return showStatus && m.status ? <span className="fu-st">{statusCode(m.status)}</span> : <span className="fu-empty">—</span>;
  }

  const isActual = !!m.actual_date;
  const date = m.actual_date || m.plan_date;
  const late = completedLate(m);
  if (!date) {
    return showStatus && m.status && normaliseStatus(m.status) !== "pending"
      ? <span className="fu-st">{statusCode(m.status)}</span>
      : <span className="fu-empty">—</span>;
  }
  return (
    <span className={"fu-cell" + (late ? " fu-late" : "")}
      title={late ? `Planned ${m.plan_date}, completed ${m.actual_date} — ${lateByDays(m)} day${lateByDays(m) === 1 ? "" : "s"} late` : undefined}>
      <span className="fu-date">{fmtCompact(date, dateFormat)}</span>
      <span className={"fu-ap " + (isActual ? "a" : "p")}>{isActual ? "A" : "P"}</span>
      {showStatus && m.status && <span className="fu-st" title={statusName(m.status)}>{statusCode(m.status)}</span>}
    </span>
  );
}

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

/* The Excel/CSV form of the same cell — plain text, no markup, same rule.
   Excel gets the fuller string because a spreadsheet column is cheap and a
   printed millimetre is not. */
function milestoneCellText(row, col, milestonesByKey, dateFormat) {
  const key = `${row.order.id}|${col.key}|${col.color_level ? row.colorName : ""}`;
  const m = milestonesByKey[key];
  if (!m) return "—";
  if (col.field_type === "pds") {
    const dateVal = m.actual_date || m.plan_date;
    if (!dateVal) return statusName(m.status);
    const mark = m.actual_date ? "A" : "P";
    const late = completedLate(m) ? ` LATE +${lateByDays(m)}d` : "";
    return `${fmtCompact(dateVal, dateFormat)} ${mark} (${statusName(m.status)})${late}`;
  }
  if (col.field_type === "text") return m.text_value || "—";
  if (col.field_type === "single") return m.single_value ? fmtCompact(m.single_value, dateFormat) : "—";
  return m.status || "—";
}

/* Printed on the sheet itself. A code nobody can decode is worse than no
   code, and a report gets read weeks later by someone who was not in the
   room when it was produced. */
function FollowUpLegend({ showStatus, printed }) {
  return (
    <div className={"fu-legend" + (printed ? " printed" : "")}>
      <span className="k"><span className="fu-ap a">A</span> Actual — completed on this date</span>
      <span className="k"><span className="fu-ap p">P</span> Planned — not yet completed</span>
      <span className="k"><span className="fu-cell fu-late"><span className="fu-date">00/00</span><span className="fu-ap a">A</span></span> completed after its plan date</span>
      {showStatus && (
        <span className="k fu-legend-st">
          Status: <b>DN</b> Done · <b>OT</b> On Track · <b>OV</b> Overdue · <b>DL</b> Delayed · <b>PN</b> Pending
          {" "}· <b>RJ</b> Rejected · <b>SB</b> Submitted <span className="fu-legend-note">(the last two arrive from PLM imports, not the T&amp;A dropdown)</span>
        </span>
      )}
    </div>
  );
}

function ReportTable({ group, cols, milestonesByKey, dateFormat, showStatus }) {
  const fuTableWidth = FU_ID_WIDTHS.reduce((a, w) => a + w, 0) + cols.length * FU_MS_WIDTH;
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ background: "#101B30", color: "#fff", padding: "8px 14px", borderRadius: "8px 8px 0 0", fontWeight: 600, fontSize: 13 }}>
        {group.label ? `${group.label.code} - ${group.label.name}` : "No Label"}
      </div>
      <div className="tna-scroll">
        {/* Explicit widths under a fixed layout. Without them the browser
            widened every milestone column to fit its header — "Fabric
            Strike-off / Handloom" alone was pushing a date column to 179px,
            nearly three times what a date needs. The header now wraps and the
            column is sized by its data. */}
        {/* The width is the exact sum of the columns. Left to stretch to the
            container the browser hands the slack back to the widest header,
            which is precisely the column that should be narrowest. */}
        <table className="data-table fu-table" style={{ width: fuTableWidth, minWidth: fuTableWidth }} data-cols={cols.length}>
          <colgroup>
            {FU_ID_WIDTHS.map((w, i) => <col key={`i${i}`} className={`fu-col-id fu-col-id-${i}`} style={{ width: w }} />)}
            {cols.map(c => <col key={c.key} className="fu-col-ms" style={{ width: FU_MS_WIDTH }} />)}
          </colgroup>
          <thead>
            <tr>
              <th>BU</th><th>PO</th><th>Style</th><th>Color</th><th>Qty</th><th>FOB</th><th>ETD</th><th>Rev ETD</th>
              {/* "Fabric Strike-off / Handloom" on one line forced the column
                  to the width of the longest header rather than the width of a
                  date. Breaking on the slash lets the header stack while the
                  column stays as narrow as its data. */}
              {cols.map(col => <th key={col.key} className="fu-msh">{wrapHeader(col.label)}</th>)}
            </tr>
          </thead>
          <tbody>
            {group.rows.map(row => (
              <tr key={row.rowId}>
                <td>{row.order.business_units?.code || "—"}</td>
                <td className="mono strong">{row.order.po_prefix}{row.order.po_number}</td>
                <td className="mono" title={row.order.style}>{row.order.style}</td>
                <td className="mono" title={row.colorName}>{row.colorName}</td>
                <td className="mono">{fmtNum(row.colorQty)}</td>
                <td className="mono">{"fob" in row.order && row.order.fob != null ? `$${Number(row.order.fob).toFixed(2)}` : "—"}</td>
                <td className="mono">{fmtCompact(row.order.etd, dateFormat)}</td>
                <td className="mono">{row.order.revised_etd ? fmtCompact(row.order.revised_etd, dateFormat) : "—"}</td>
                {cols.map(col => <td key={col.key} className="fu-ms">{milestoneCell(row, col, milestonesByKey, dateFormat, showStatus)}</td>)}
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
  const [excelSheets, setExcelSheets] = useState(null);
  const [showPrint, setShowPrint] = useState(false);
  /* On by default: the Status is a business field, and a management sheet
     that quietly dropped it would be missing the thing it is read for. It can
     be switched off for a purely date-focused factory hand-out. */
  const [showStatus, setShowStatus] = useState(true);

  /* The column headers stick directly under the toolbar. Its height is
     measured rather than hardcoded — it wraps to two or three rows on a narrow
     window, and a fixed offset would either overlap the headers or leave a
     gap. */
  const toolbarRef = useRef(null);
  useEffect(() => {
    const el = toolbarRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const set = () => document.documentElement.style.setProperty("--fu-toolbar-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
    /* Preview first -- converted from the array-of-arrays shape to row
       objects so the same rows can be both rendered on screen and written
       to the file, rather than the file being built from a second,
       separately-assembled structure. */
    const objRows = rowsOut.map(vals => Object.fromEntries(headers.map((h, i) => [h, vals[i]])));
    setExcelSheets([{
      name: "Follow-up Report", rows: objRows, columns: headers,
      totals: { Label: "Total", Qty: objRows.reduce((s2, r) => s2 + (Number(r.Qty) || 0), 0) },
    }]);
  }

  if (loading) return <div style={{ padding: 32 }}>Loading...</div>;

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginTop: 0 }}>Follow-up Report</h2>
      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}

      {/* Filters, the status toggle and Print stay put while the report
          scrolls. On a sheet grouped into label sections you are often deep in
          the third group when you decide to change a filter or print — having
          to scroll back to the top for that was the complaint. */}
      <div className="fu-toolbar" ref={toolbarRef}>
      <div className="filter-row">
        <select value={filters.factoryCode} onChange={e => setFilters({ ...filters, factoryCode: e.target.value })}><option value="all">All Factories</option>{factories.map(f => <option key={f} value={f}>{f}</option>)}</select>
        <select value={filters.merchandiser} onChange={e => setFilters({ ...filters, merchandiser: e.target.value })}><option value="all">All Merchandisers</option>{merchandisers.map(m => <option key={m} value={m}>{m}</option>)}</select>
        <select value={filters.productGroup} onChange={e => setFilters({ ...filters, productGroup: e.target.value })}><option value="all">All Product Groups</option>{productGroups.map(p => <option key={p} value={p}>{p}</option>)}</select>
        <select value={filters.customerCode} onChange={e => setFilters({ ...filters, customerCode: e.target.value })}><option value="all">All Customers</option>{customers.map(c => <option key={c} value={c}>{c}</option>)}</select>
        <input type="date" value={filters.etdFrom} onChange={e => setFilters({ ...filters, etdFrom: e.target.value })} title="ETD from" />
        <span style={{ alignSelf: "center", color: "#9CA3AF" }}>to</span>
        <input type="date" value={filters.etdTo} onChange={e => setFilters({ ...filters, etdTo: e.target.value })} title="ETD to" />
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <label className="fu-toggle" title="Show the milestone Status code beside each date">
            <input type="checkbox" checked={showStatus} onChange={e => setShowStatus(e.target.checked)} />
            Status codes
          </label>
          <ColumnSettingsButton milestoneTypes={milestoneTypes} colPrefs={colPrefs} setColPrefs={setColPrefs} onPersist={saveFollowUpColumnPrefs} />
          <button className="btn-ghost-sm" onClick={exportExcel}>Export to Excel</button>
          <button className="btn-primary" onClick={() => setShowPrint(true)}>Print Report</button>
        </div>
      </div>
      <FollowUpLegend showStatus={showStatus} />
      </div>
      <p className="muted-sm" style={{ marginBottom: 14 }}>Grouped by Label — each section below is its own Label banner followed by that label's orders, one row per Color Way. Use Columns to add back fields not shown by default before printing if a particular meeting needs them.</p>

      {groups.map((g, i) => <ReportTable key={g.label?.code || i} group={g} cols={cols} milestonesByKey={milestonesByKey} dateFormat={dateFormat} showStatus={showStatus} />)}
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
              {groups.map((g, i) => <ReportTable key={g.label?.code || i} group={g} cols={cols} milestonesByKey={milestonesByKey} dateFormat={dateFormat} showStatus={showStatus} />)}
              <FollowUpLegend showStatus={showStatus} printed />
              <p className="muted-sm">
                Printed for factory / management review. Measured on this layout: <strong>twelve milestones fit A4
                landscape</strong> alongside the eight identity columns. The default set is ten, so it fits — past
                twelve, drop a column or print A3.
                {cols.length > FU_A4_MILESTONES && <strong style={{ color: "#B91C1C" }}> {cols.length} milestones are selected, which will overflow A4 — use A3 or remove {cols.length - FU_A4_MILESTONES}.</strong>}
              </p>
            </div>
          </div>
        </div>
      )}
      {excelSheets && (
        <ExcelPreviewModal
          title="Merchandising Follow-up Report"
          subtitle="PEI Bangladesh · AI Merchandising ERP"
          meta="Colour-level rows with the milestone columns currently shown"
          sheets={excelSheets}
          fileName={`Merchandising_Followup_Report_${stamp()}.xlsx`}
          onClose={() => setExcelSheets(null)}
        />
      )}
    </div>
  );
}
