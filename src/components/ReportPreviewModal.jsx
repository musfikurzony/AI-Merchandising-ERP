import React from "react";
import { usePreviewSize, MaximizeButton } from "./usePreviewSize.jsx";
import { generateCorporatePDF } from "../lib/pdfReportApi.js";

/* PDF export, preview first.

   "Export PDF" no longer writes a file on click. It opens this: the
   report drawn on screen in the same order and proportions the generated
   PDF uses -- company line, title, period/filter metadata, KPI boxes, the
   table with its totals as the closing row, and the document footer. Only
   "Download PDF" actually produces the file.

   Crucially, this component and generateCorporatePDF() are handed the
   EXACT SAME descriptor object. There is no separate "what the PDF will
   contain" assembly step that could disagree with what was previewed --
   the preview renders the descriptor, and the download hands the same
   descriptor straight to the generator. */

export default function ReportPreviewModal({ descriptor, onClose }) {
  const { maximized, toggle, boxClass } = usePreviewSize(onClose);
  if (!descriptor) return null;
  const {
    companyName = "PERRY ELLIS INTERNATIONAL — BANGLADESH",
    reportName, periodLabel, filterLabels = [], kpis = [],
    columns = [], rows = [], totalsRow, fileName,
  } = descriptor;

  const generatedAt = new Date().toLocaleString("en-US", { day: "2-digit", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
  const metaLine = [periodLabel, ...filterLabels, `Generated: ${generatedAt}`].filter(Boolean).join("   |   ");

  return (
    <div className="pv-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={boxClass}>
        <div className="pv-head">
          <div className="pv-headrow">
            <div className="pv-eyebrow">PDF export — preview</div>
            <MaximizeButton maximized={maximized} onToggle={toggle} />
          </div>
          <h3 className="pv-title">{reportName}</h3>
          <div className="pv-meta">This is the document that will be produced — {rows.length.toLocaleString()} rows, A4 landscape. Nothing is saved to your computer until you press Download.</div>
        </div>

        <div className="pv-body">
          <div className="pv-paper">
            <div className="co">{companyName}</div>
            <h3>{reportName}</h3>
            <div className="meta">{metaLine}</div>

            {kpis.length > 0 && (
              <div className="pv-kpis">
                {kpis.map(k => (
                  <div className="pv-kpi" key={k.label}>
                    <div className="v">{k.value}</div>
                    <div className="l">{k.label}</div>
                  </div>
                ))}
              </div>
            )}

            <table>
              <thead>
                <tr>{columns.map(c => <th key={c.key} style={{ textAlign: c.align === "right" ? "right" : c.align === "center" ? "center" : "left" }}>{c.header}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    {columns.map(c => (
                      <td key={c.key} style={{ textAlign: c.align === "right" ? "right" : c.align === "center" ? "center" : "left", fontVariantNumeric: "tabular-nums" }}>
                        {r[c.key] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={columns.length || 1} style={{ textAlign: "center", padding: 22, color: "#9AA0AA" }}>No rows for the current filters.</td></tr>}
              </tbody>
              {totalsRow && (
                <tfoot>
                  <tr>
                    {columns.map(c => (
                      <td key={c.key} style={{ textAlign: c.align === "right" ? "right" : c.align === "center" ? "center" : "left", fontVariantNumeric: "tabular-nums" }}>
                        {totalsRow[c.key] ?? ""}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>

            <div className="pfoot">
              <span>{reportName}</span>
              <span>Page 1 of {Math.max(1, Math.ceil(rows.length / 22))} (approx.) · Developed by Musfikur Rahman</span>
            </div>
          </div>
        </div>

        <div className="pv-foot">
          <button className="btn-outline" onClick={() => window.print()}>Print this preview</button>
          <span className="spacer" />
          <button className="btn-outline" onClick={onClose}>Close</button>
          <button className="btn-amber" onClick={() => generateCorporatePDF(descriptor)}>Download PDF</button>
        </div>
      </div>
    </div>
  );
}
