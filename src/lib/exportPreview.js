import * as XLSX from "xlsx";

/* Shared export plumbing for the "preview first, download second" model.

   The explicit requirement: nothing downloads straight off a button click
   any more. An Excel export first renders IN THE BROWSER as a real table
   the user can read and copy out of, and only downloads if they then ask
   for the file. A PDF export first renders an on-screen page laid out
   exactly like the document, and only writes the .pdf if they then ask.

   The important consequence for correctness: the preview and the file are
   built from ONE array of row objects, never two. What is shown is
   literally the data that gets written -- there is no second, separately
   assembled "export version" that could drift away from the preview. */

/* A sheet is { name, rows } where rows is an array of plain objects with
   identical keys -- the exact shape XLSX.utils.json_to_sheet already
   takes, so no conversion layer is needed between preview and file. */
export function sheetColumns(sheet) {
  if (sheet.columns) return sheet.columns;
  const seen = [];
  for (const row of sheet.rows || []) {
    for (const k of Object.keys(row)) if (!seen.includes(k)) seen.push(k);
  }
  return seen;
}

export function isNumericColumn(sheet, col) {
  const rows = sheet.rows || [];
  let numeric = 0, considered = 0;
  for (const r of rows.slice(0, 60)) {
    const v = r[col];
    if (v === null || v === undefined || v === "") continue;
    considered++;
    if (typeof v === "number") numeric++;
  }
  return considered > 0 && numeric / considered > 0.7;
}

/* Tab-separated is deliberate: pasting TSV into Excel or Google Sheets
   lands each value in its own cell, which is exactly the "copy it and
   build my own manual report" case this was asked for. CSV would break
   on any value containing a comma (customer names routinely do). */
export function sheetToTSV(sheet) {
  const cols = sheetColumns(sheet);
  const clean = v => (v === null || v === undefined ? "" : String(v).replace(/[\t\r\n]+/g, " "));
  const lines = [cols.join("\t")];
  for (const row of sheet.rows || []) lines.push(cols.map(c => clean(row[c])).join("\t"));
  if (sheet.totals) lines.push(cols.map(c => clean(sheet.totals[c])).join("\t"));
  return lines.join("\n");
}

/* navigator.clipboard is unavailable on insecure origins and in some
   embedded browsers -- falls back to the textarea+execCommand method
   rather than silently failing, since "copy" failing quietly is worse
   than an older API. */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path below */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch { return false; }
}

/* One workbook builder, used by every Excel export in the app. A sheet's
   optional `totals` object is appended as the LAST row of that sheet --
   the same bottom-line placement the on-screen tables use, so the
   downloaded file reads the same way the screen does. */
export function buildWorkbook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const cols = sheetColumns(sheet);
    const body = (sheet.rows || []).map(r => Object.fromEntries(cols.map(c => [c, r[c] ?? ""])));
    if (sheet.totals) body.push(Object.fromEntries(cols.map(c => [c, sheet.totals[c] ?? ""])));

    /* An optional corporate header block above the table — company, report
       name and type, period, date basis and the filters actually applied.
       It is written as real cells before the column headers so the file is
       readable on its own: a sheet that lands in someone's inbox has to say
       what it is, what period it covers and what was filtered out, or it
       cannot be trusted as a management document. */
    let ws;
    if (sheet.header && sheet.header.length) {
      ws = XLSX.utils.aoa_to_sheet(sheet.header.map(line => (Array.isArray(line) ? line : [line])));
      XLSX.utils.sheet_add_json(ws, body, { header: cols, origin: -1 });
    } else {
      ws = XLSX.utils.json_to_sheet(body, { header: cols });
    }
    ws["!cols"] = cols.map(c => ({ wch: Math.min(38, Math.max(10, String(c).length + 4)) }));
    // Excel caps sheet names at 31 chars and rejects : \ / ? * [ ]
    const safeName = String(sheet.name || "Sheet").replace(/[:\\/?*[\]]/g, "-").slice(0, 31);
    XLSX.utils.book_append_sheet(wb, ws, safeName);
  }
  return wb;
}

export function downloadWorkbook(sheets, fileName) {
  XLSX.writeFile(buildWorkbook(sheets), fileName);
}

export function stamp() {
  return new Date().toISOString().slice(0, 10);
}
