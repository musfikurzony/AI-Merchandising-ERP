import React, { useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { fieldsFor, isRequired } from "../lib/importFields.js";

/* "Make it easy for Licensee orders, because we receive orders by excel or
   email body etc."

   The email-body half had no answer at all: the import took a FILE, so an
   order sitting in an email had to be pasted into Excel, saved somewhere,
   found again and uploaded — four steps that exist only because the code
   wanted a file.

   Select the rows in the email or the spreadsheet, paste them here, and the
   text is turned into a workbook in the browser and handed to the same
   parser. Nothing about the import changes: the same field rules, the same
   date handling, the same analyse-then-import preview. This is a different
   way in, not a different importer — a second parser would be a second set
   of rules to keep in step.

   --------------------------------------------------------------------------
   TAB-SEPARATED, AND A HEADER ROW IS OPTIONAL
   --------------------------------------------------------------------------
   Copying from Excel, Google Sheets or an Outlook table puts TAB between
   cells, so that is the separator. Commas are deliberately not supported:
   customer names contain them ("INDUSTRIAS TOPAZ LTDA. DE C.V."), and
   splitting on a comma would silently cut a row into the wrong columns.

   If the pasted block has no heading row, the template's own headings are
   added — that is the common case when somebody copies just the rows out of
   a table they were sent.
*/

const TEMPLATE_HEADERS = source => fieldsFor(source).map(f => f.header);

/* Does the first line look like headings rather than data? Decided by
   matching against the known column names rather than by guessing from
   shape: a data row and a header row are both just strings, and "does it
   contain numbers" is wrong the moment a PO is called "TP13-SP27 HATS". */
export function looksLikeHeader(cells, source) {
  const known = TEMPLATE_HEADERS(source).map(h => h.toLowerCase());
  const hits = cells.filter(c => known.includes(String(c || "").trim().toLowerCase())).length;
  return hits >= 2;
}

export function parsePasted(text, source) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n").filter(l => l.trim() !== "");
  if (!lines.length) return { rows: [], addedHeader: false, error: null };

  const grid = lines.map(l => l.split("\t").map(c => c.trim()));
  if (grid.length === 1 && grid[0].length < 2) {
    return { rows: [], addedHeader: false, error: "That does not look like spreadsheet rows — copy the cells from Excel or the table in the email, not plain text." };
  }

  if (looksLikeHeader(grid[0], source)) return { rows: grid, addedHeader: false, error: null };
  return { rows: [TEMPLATE_HEADERS(source), ...grid], addedHeader: true, error: null };
}

/* A real .xlsx File object, so the existing importer needs no new entry
   point and no "is this a paste or a file" branch anywhere downstream. */
export function pastedToFile(grid, name = "pasted-order.xlsx") {
  const ws = XLSX.utils.aoa_to_sheet(grid);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Licensee Import");
  const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  return new File([out], name, { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export default function PasteRows({ source, onReady, disabled }) {
  const [text, setText] = useState("");
  const [error, setError] = useState(null);

  const preview = useMemo(() => {
    if (!text.trim()) return null;
    const { rows, addedHeader, error } = parsePasted(text, source);
    if (error) return { error };
    return {
      addedHeader,
      cols: rows[0]?.length || 0,
      dataRows: Math.max(0, rows.length - 1),
      head: rows[0] || [],
      sample: rows.slice(1, 4),
    };
  }, [text, source]);

  function use() {
    setError(null);
    const { rows, error: e } = parsePasted(text, source);
    if (e) { setError(e); return; }
    if (rows.length < 2) { setError("No data rows found — paste the order lines as well as the headings."); return; }
    onReady(pastedToFile(rows), { addedHeader: !looksLikeHeader(rows[0], source), rows: rows.length - 1 });
  }

  const required = fieldsFor(source).filter(f => isRequired(f, source)).map(f => f.header);

  return (
    <div className="pr-wrap">
      <p className="pr-lead">
        Orders that arrive in an email body do not need saving to a file first. Select
        the rows in the email or spreadsheet, copy, and paste them here.
        {" "}Headings are optional — if you paste only the rows, the template's headings
        are used, so the columns must be in the template's order.
      </p>
      <p className="pr-req">Must include: <strong>{required.join(", ")}</strong></p>

      <textarea
        className="pr-text"
        rows={6}
        placeholder={"Paste rows here — copied straight from Excel, Google Sheets or a table in an email."}
        value={text}
        onChange={e => setText(e.target.value)}
        disabled={disabled}
      />

      {preview?.error && <p className="pr-err">{preview.error}</p>}
      {error && <p className="pr-err">{error}</p>}

      {preview && !preview.error && (
        <div className="pr-preview">
          <div className="pr-stat">
            <strong>{preview.dataRows}</strong> row{preview.dataRows !== 1 ? "s" : ""} ·{" "}
            <strong>{preview.cols}</strong> column{preview.cols !== 1 ? "s" : ""}
            {preview.addedHeader && <span className="pr-added">headings added from the template</span>}
          </div>
          <div className="pr-scroll">
            <table className="data-table pr-table">
              <thead><tr>{preview.head.map((h, i) => <th key={i}>{h || "—"}</th>)}</tr></thead>
              <tbody>
                {preview.sample.map((r, i) => (
                  <tr key={i}>{preview.head.map((_, j) => <td key={j}>{r[j] ?? ""}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="pr-actions">
        <button className="btn-primary" onClick={use} disabled={disabled || !text.trim()}>
          Use these rows
        </button>
        {text && <button className="btn-outline" onClick={() => { setText(""); setError(null); }}>Clear</button>}
      </div>
    </div>
  );
}
