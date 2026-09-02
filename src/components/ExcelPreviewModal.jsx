import React, { useState } from "react";
import { sheetColumns, isNumericColumn, sheetToTSV, copyToClipboard, downloadWorkbook } from "../lib/exportPreview.js";

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
   every row. */

const PREVIEW_LIMIT = 300;

function fmtCell(v) {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "number") return v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return String(v);
}

export default function ExcelPreviewModal({ title, subtitle, meta, sheets, fileName, onClose }) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(null);
  const usable = (sheets || []).filter(Boolean);
  const sheet = usable[active] || { name: "Sheet", rows: [] };
  const cols = sheetColumns(sheet);
  const rows = sheet.rows || [];
  const shown = rows.slice(0, PREVIEW_LIMIT);
  const numericCols = new Set(cols.filter(c => isNumericColumn(sheet, c)));

  async function handleCopy() {
    const ok = await copyToClipboard(sheetToTSV(sheet));
    setCopied(ok ? `Copied "${sheet.name}" — ${rows.length.toLocaleString()} rows, paste into Excel or Sheets` : "Copy failed — select the table and use Ctrl+C");
    setTimeout(() => setCopied(null), 4000);
  }

  const totalRows = usable.reduce((s, sh) => s + (sh.rows?.length || 0), 0);

  return (
    <div className="pv-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pv-box">
        <div className="pv-head">
          <div className="pv-eyebrow">Excel export — preview</div>
          <h3 className="pv-title">{title}</h3>
          <div className="pv-meta">
            {[subtitle, meta, `${usable.length} sheet${usable.length === 1 ? "" : "s"} · ${totalRows.toLocaleString()} rows total`].filter(Boolean).join("  ·  ")}
          </div>
          {usable.length > 1 && (
            <div className="pv-tabs">
              {usable.map((s, i) => (
                <button key={s.name} className={"pv-tab" + (i === active ? " active" : "")} onClick={() => setActive(i)}>
                  {s.name} <span style={{ opacity: .65 }}>({(s.rows?.length || 0).toLocaleString()})</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="pv-body">
          {sheet.header && sheet.header.length > 0 && (
            <div className="pv-xls-header">
              {sheet.header.map((line, i) => {
                const cells = Array.isArray(line) ? line : [line];
                const text = cells.filter(Boolean).join("  ");
                if (!text) return <div key={i} style={{ height: 6 }} />;
                return <div key={i} className={i === 0 ? "co" : i === 1 ? "sub" : "meta"}>{text}</div>;
              })}
            </div>
          )}
          <div className="pv-sheet">
            <table>
              <thead><tr>{cols.map(c => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={i}>
                    {cols.map(c => <td key={c} className={numericCols.has(c) ? "num" : ""}>{fmtCell(r[c])}</td>)}
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={cols.length || 1} style={{ textAlign: "center", padding: 26, color: "#9AA0AA" }}>This sheet has no rows for the current filters.</td></tr>}
              </tbody>
              {sheet.totals && (
                <tfoot>
                  <tr>
                    {cols.map(c => (
                      <td key={c} className={numericCols.has(c) ? "num" : ""} style={{ background: "#F7F4EE", fontWeight: 700, borderTop: "2px solid #E7E2D8", position: "sticky", bottom: 0 }}>
                        {fmtCell(sheet.totals[c])}
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
          <span style={{ fontSize: 11.5, color: "#6B7280" }}>Copies as tab-separated — pastes straight into Excel or Google Sheets.</span>
          <span className="spacer" />
          <button className="btn-outline" onClick={onClose}>Close</button>
          <button className="btn-amber" onClick={() => downloadWorkbook(usable, fileName)}>Download .xlsx</button>
        </div>
      </div>
    </div>
  );
}
