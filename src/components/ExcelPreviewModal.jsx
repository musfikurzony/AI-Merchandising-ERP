import React, { useMemo, useState } from "react";
import { usePreviewSize, MaximizeButton } from "./usePreviewSize.jsx";
import ColumnFilter from "./ColumnFilter.jsx";
import { sheetColumns, isNumericColumn, sheetToTSV, copyToClipboard, downloadWorkbook } from "../lib/exportPreview.js";
import { filterSheet, isFiltered, filteredColumns, describe } from "../lib/sheetFilter.js";

/* Excel export, preview first.

   Clicking "Export Excel" anywhere in the app now opens this: every sheet
   of the workbook rendered as a real browser table the user can read,
   scroll, select and copy out of. The .xlsx file is written only if they
   press Download -- so the common case ("I just want to see these numbers
   / paste them into my own sheet") never puts a file on their disk at
   all, exactly as asked.

   The preview is capped at PREVIEW_LIMIT rows per sheet for browser
   responsiveness, and that cap is stated on screen rather than silently
   truncating -- the downloaded file and the copied TSV always contain
   every row.

   From v92 every column header carries a filter, the way the PLM export
   window does. The filter is applied to the SHEET, not to the table: what
   is copied and what is downloaded are the filtered rows, and the totals
   line is re-summed from them. See lib/sheetFilter.js for why each of
   those is deliberate. */

const PREVIEW_LIMIT = 300;

function fmtCell(v) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return String(v);
}

export default function ExcelPreviewModal({ title, subtitle, meta, sheets, fileName, onClose }) {
  const { maximized, toggle, boxClass } = usePreviewSize(onClose);
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(null);
  /* Filters are per SHEET, keyed by sheet name: the Order Summary tab and
     the Shipment Details tab have different columns, and carrying one tab's
     filter onto another would either do nothing or filter the wrong thing. */
  const [filtersBySheet, setFiltersBySheet] = useState({});

  const usable = (sheets || []).filter(Boolean);
  const sheet = usable[active] || { name: "Sheet", rows: [] };
  const filters = filtersBySheet[sheet.name] || {};

  const view = useMemo(() => filterSheet(sheet, filters), [sheet, filters]);
  const cols = sheetColumns(view);
  const rows = view.rows || [];
  const allRows = sheet.rows || [];
  const shown = rows.slice(0, PREVIEW_LIMIT);
  /* Numeric alignment is decided from the UNFILTERED sheet. Deciding it
     from the filtered rows would let a column change alignment as you
     filter, which looks like a rendering bug. */
  const numericCols = useMemo(() => new Set(cols.filter(c => isNumericColumn(sheet, c))), [sheet, cols]);

  const filtering = isFiltered(filters);
  const activeCols = filteredColumns(filters);

  /* Every sheet in the workbook is exported with its own filter applied —
     a filter set on the Color Details tab must survive downloading the
     whole workbook, or the file would not match what was on screen. */
  const exportSheets = useMemo(
    () => usable.map(s => filterSheet(s, filtersBySheet[s.name] || {})),
    [usable, filtersBySheet]);

  function setFilters(next) {
    setFiltersBySheet(prev => ({ ...prev, [sheet.name]: next }));
  }
  function clearAll() {
    setFiltersBySheet(prev => { const c = { ...prev }; delete c[sheet.name]; return c; });
  }

  async function handleCopy() {
    const ok = await copyToClipboard(sheetToTSV(view));
    setCopied(ok
      ? `Copied "${sheet.name}" — ${rows.length.toLocaleString()} row${rows.length === 1 ? "" : "s"}${filtering ? " (filtered)" : ""}, paste into Excel or Sheets`
      : "Copy failed — select the table and use Ctrl+C");
    setTimeout(() => setCopied(null), 4000);
  }

  const totalRows = exportSheets.reduce((s, sh) => s + (sh.rows?.length || 0), 0);

  return (
    <div className="pv-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={boxClass}>
        <div className="pv-head">
          <div className="pv-headrow">
            <div className="pv-eyebrow">Excel export — preview</div>
            <MaximizeButton maximized={maximized} onToggle={toggle} />
          </div>
          <h3 className="pv-title">{title}</h3>
          <div className="pv-meta">
            {[subtitle, meta, `${usable.length} sheet${usable.length === 1 ? "" : "s"} · ${totalRows.toLocaleString()} rows total`].filter(Boolean).join("  ·  ")}
          </div>
          {usable.length > 1 && (
            <div className="pv-tabs">
              {usable.map((s, i) => {
                const f = filtersBySheet[s.name] || {};
                const n = isFiltered(f) ? filterSheet(s, f).rows.length : (s.rows?.length || 0);
                return (
                  <button key={s.name} className={"pv-tab" + (i === active ? " active" : "") + (isFiltered(f) ? " filtered" : "")} onClick={() => setActive(i)}>
                    {s.name} <span style={{ opacity: .65 }}>({n.toLocaleString()})</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="pv-body">
          {filtering && (
            <div className="cf-bar">
              <span className="cf-bar-ttl">Filtered</span>
              <span className="cf-bar-txt">
                {describe(filters)} — <strong>{rows.length.toLocaleString()}</strong> of {allRows.length.toLocaleString()} rows
              </span>
              <span className="spacer" />
              {activeCols.map(c => (
                <button key={c} className="cf-chip" title={`Clear the ${c} filter`}
                  onClick={() => { const n = { ...filters }; delete n[c]; setFilters(n); }}>
                  {c} ✕
                </button>
              ))}
              <button className="btn-link xs" onClick={clearAll}>Clear all</button>
            </div>
          )}

          {view.header && view.header.length > 0 && (
            <div className="pv-xls-header">
              {view.header.map((line, i) => {
                const cells = Array.isArray(line) ? line : [line];
                const text = cells.filter(Boolean).join("  ");
                if (!text) return <div key={i} style={{ height: 6 }} />;
                return <div key={i} className={i === 0 ? "co" : i === 1 ? "sub" : "meta"}>{text}</div>;
              })}
            </div>
          )}
          <div className="pv-sheet">
            <table>
              <thead>
                <tr>
                  {cols.map(c => (
                    <th key={c} className={(numericCols.has(c) ? "num" : "") + (filters[c]?.size ? " cf-on" : "")}>
                      <span className="cf-th">
                        <span className="cf-th-text">{c}</span>
                        <ColumnFilter
                          col={c}
                          rows={allRows}
                          filters={filters}
                          onChange={setFilters}
                          align={numericCols.has(c) ? "right" : "left"}
                        />
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={i}>
                    {cols.map(c => <td key={c} className={numericCols.has(c) ? "num" : ""}>{fmtCell(r[c])}</td>)}
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr><td colSpan={cols.length || 1} style={{ textAlign: "center", padding: 26, color: "#9AA0AA" }}>
                    {filtering
                      ? "No row matches this filter. Clear it, or widen the values selected."
                      : "This sheet has no rows for the current filters."}
                  </td></tr>
                )}
              </tbody>
              {view.totals && (
                <tfoot>
                  <tr>
                    {cols.map(c => (
                      <td key={c} className={numericCols.has(c) ? "num" : ""} style={{ background: "#F7F4EE", fontWeight: 700, borderTop: "2px solid #E7E2D8", position: "sticky", bottom: 0 }}>
                        {fmtCell(view.totals[c])}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {rows.length > PREVIEW_LIMIT && (
            <p className="pv-note">
              Showing the first {PREVIEW_LIMIT.toLocaleString()} of {rows.length.toLocaleString()} rows on screen. Copy and Download both include <strong>all {rows.length.toLocaleString()}</strong>.
            </p>
          )}
          {copied && <p className="pv-note" style={{ color: "#1F7A5C", fontWeight: 600 }}>{copied}</p>}
        </div>

        <div className="pv-foot">
          <button className="btn-outline" onClick={handleCopy}>Copy this sheet</button>
          <span style={{ fontSize: 11.5, color: "#6B7280" }}>
            {filtering
              ? "Copy and Download both use the filtered rows, with the total re-summed."
              : "Copies as tab-separated — pastes straight into Excel or Google Sheets."}
          </span>
          <span className="spacer" />
          <button className="btn-outline" onClick={onClose}>Close</button>
          <button className="btn-amber" onClick={() => downloadWorkbook(exportSheets, fileName)}>Download .xlsx</button>
        </div>
      </div>
    </div>
  );
}
