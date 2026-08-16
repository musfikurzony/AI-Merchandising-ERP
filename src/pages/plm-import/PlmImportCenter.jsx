import React, { useState, useRef } from "react";
import { Link } from "react-router-dom";
import * as XLSX from "xlsx";
import { inspectWorkbook, parseSheet, classifyAndPreview, groupByOrder, executeImport, listImportHistory, previewImportBatchDeletion, deleteImportBatch } from "../../lib/plmImportApi.js";

function downloadLicenseeTemplate() {
  const headers = ["PO Prefix", "PO #", "Style#", "Color Way", "Ordered Quantity", "PO Issue Date", "Division", "Business Unit", "Customer Name", "Product Group", "Label", "Season", "Latest Required X-Country Ship Date", "Unit_Price"];
  const example = ["LI", "1001", "ABC123", "MAIN", 500, "2026-01-15", "", "", "", "SHIRTS", "", "", "2026-06-01", 4.5];
  const ws = XLSX.utils.aoa_to_sheet([headers, example]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Licensee Import");
  XLSX.writeFile(wb, "ERP_Licensee_Import_Template.xlsx");
}

/* Import batch history + safe, previewed deletion -- the backend
   (Migration 17) has existed for a while, tested, but had no UI anywhere
   calling it, confirmed as a real, prioritized gap. "Preview first, then
   confirm" mirrors the same pattern used for order deletion previews
   elsewhere -- shows exactly what would be removed (and what would be
   protected, e.g. an order since manually edited by another workflow)
   before anything is actually deleted. Requires Migration 17 to be
   applied to the live database; until then this will show a clear
   "function does not exist" error rather than fail silently. */
function ImportHistoryPanel() {
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [previewing, setPreviewing] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [result, setResult] = useState(null);
  const [force, setForce] = useState(false);

  async function refresh() {
    setLoading(true); setError(null);
    try { setBatches(await listImportHistory()); }
    catch (e) { setError(e.message); }
    setLoading(false);
  }
  React.useEffect(() => { refresh(); }, []);

  async function openPreview(batch) {
    setPreviewing(batch); setPreview(null); setPreviewError(null); setResult(null); setForce(false);
    try { setPreview(await previewImportBatchDeletion(batch.id, false)); }
    catch (e) { setPreviewError(e.message); }
  }

  async function toggleForce() {
    const next = !force;
    setForce(next);
    try { setPreview(await previewImportBatchDeletion(previewing.id, next)); }
    catch (e) { setPreviewError(e.message); }
  }

  async function confirmDelete() {
    setDeleting(true); setPreviewError(null);
    try {
      const r = await deleteImportBatch(previewing.id, force);
      setResult(r);
      setPreviewing(null); setPreview(null); setForce(false);
      await refresh();
    } catch (e) { setPreviewError(e.message); }
    setDeleting(false);
  }

  return (
    <div>
      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
      {result && <div style={{ background: "#DCFCE7", padding: 12, borderRadius: 8, marginBottom: 14 }}>Batch deleted — {result.orders_deleted} order(s) removed.</div>}
      {loading ? <p>Loading...</p> : (
        <div className="card no-pad">
          <table className="data-table">
            <thead><tr><th>File</th><th>Source</th><th>Uploaded By</th><th>Uploaded At</th><th>New</th><th>Updated</th><th>Duplicates</th><th>Errors</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {batches.map(b => (
                <tr key={b.id}>
                  <td>{b.file_name}</td>
                  <td>{b.source}</td>
                  <td>{b.profiles?.full_name || "—"}</td>
                  <td className="muted-sm">{new Date(b.uploaded_at).toLocaleString()}</td>
                  <td className="mono">{b.new_count}</td>
                  <td className="mono">{b.updated_count}</td>
                  <td className="mono">{b.duplicate_count}</td>
                  <td className="mono">{b.error_count}</td>
                  <td><span className="pill" style={{ background: "#F3F4F6", color: "#374151" }}>{b.status}</span></td>
                  <td><button className="btn-ghost-sm" style={{ color: "#B91C1C" }} onClick={() => openPreview(b)}>Delete...</button></td>
                </tr>
              ))}
              {batches.length === 0 && <tr><td colSpan={10} className="empty-row">No import batches yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {previewing && (
        <div className="modal-overlay">
          <div className="modal-box" style={{ width: 560 }}>
            <div className="modal-title">Delete import batch — {previewing.file_name}</div>
            {previewError && <p style={{ color: "#B91C1C", fontSize: 13 }}>{previewError}</p>}
            {!preview && !previewError && <p className="muted-sm">Checking what this would affect...</p>}
            {preview && (
              <>
                <p className="muted-sm">
                  Uploaded by {preview.uploaded_by || "—"} on {preview.uploaded_at ? new Date(preview.uploaded_at).toLocaleString() : "—"}.
                </p>
                <div style={{ background: "#F9FAFB", borderRadius: 8, padding: 12, marginBottom: 10 }}>
                  <div><b>{preview.orders_safe_to_delete}</b> order(s) will be permanently deleted</div>
                  <div className="muted-sm"><b>{preview.color_ways_to_delete}</b> color way record(s) will go with them</div>
                </div>
                {preview.orders_flagged?.length > 0 && (
                  <div style={{ background: "#FEF3C7", borderRadius: 8, padding: 12, marginBottom: 10 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{preview.orders_flagged.length} order(s) will be kept, not deleted:</div>
                    {preview.orders_flagged.map((f, i) => <div key={i} className="muted-sm">{f.po} — {f.reason}</div>)}
                    {preview.orders_flagged.some(f => f.reason === "factory assigned") && (
                      <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10, fontSize: 12.5, cursor: "pointer" }}>
                        <input type="checkbox" checked={force} onChange={toggleForce} />
                        Also delete orders whose only issue is a factory assignment — orders with real CRD/shipment/sample history stay protected either way.
                      </label>
                    )}
                  </div>
                )}
              </>
            )}
            {previewError?.includes("Could not find the function") && (
              <div style={{ background: "#FEF3C7", borderRadius: 8, padding: 12, marginBottom: 10, fontSize: 13 }}>
                This requires a database migration that hasn't been run on this project yet
                (adds the safe-delete functions this screen needs). Nothing can be deleted until it is.
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button className="btn-ghost-sm" onClick={() => { setPreviewing(null); setPreview(null); setForce(false); }} disabled={deleting}>{preview ? "Cancel" : "Close"}</button>
              {preview && (
                <button className="btn-primary" style={{ background: "#B91C1C" }} onClick={confirmDelete} disabled={deleting}>
                  {deleting ? "Deleting..." : `Delete ${preview.orders_safe_to_delete} order(s) permanently`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function PlmImportCenter() {
  const [view, setView] = useState("import");
  const [source, setSource] = useState("plm");
  const [file, setFile] = useState(null);
  const [sheetInfo, setSheetInfo] = useState(null);
  const [selectedSheet, setSelectedSheet] = useState(null);
  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState(null);
  const [classified, setClassified] = useState(null);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const cancelledRef = useRef(false);

  async function handleFileChange(e) {
    const f = e.target.files[0];
    setFile(f); setClassified(null); setResult(null); setParseResult(null); setError(null);
    if (!f) { setSheetInfo(null); return; }
    try {
      const info = await inspectWorkbook(f);
      setSheetInfo(info);
      setSelectedSheet(info.suggested);
    } catch (e) {
      setError(e.message);
    }
  }

  async function handleAnalyze() {
    if (!file || !selectedSheet) return;
    setParsing(true); setError(null); setClassified(null); setResult(null);
    try {
      const parsed = await parseSheet(file, source, selectedSheet);
      setParseResult(parsed);
      if (parsed.missingRequired.length > 0) {
        setError(`Required column(s) not found in sheet "${selectedSheet}": ${parsed.missingRequired.join(", ")}`);
        setParsing(false);
        return;
      }
      const cls = await classifyAndPreview(parsed.rows);
      setClassified(cls.rows);
    } catch (e) {
      setError(e.message);
    }
    setParsing(false);
  }

  async function handleConfirm() {
    cancelledRef.current = false;
    setImporting(true); setError(null);
    try {
      const summary = await executeImport(classified, source, file.name, cancelledRef);
      setResult(summary);
      setClassified(null); setFile(null); setParseResult(null); setSheetInfo(null);
    } catch (e) {
      setError(e.message);
    }
    setImporting(false);
  }
  function handleCancelImport() {
    cancelledRef.current = true;
  }

  const counts = classified ? {
    total: classified.length,
    new: classified.filter(r => r.classification === "new").length,
    updated: classified.filter(r => r.classification === "updated").length,
    duplicate: classified.filter(r => r.classification === "duplicate").length,
    error: classified.filter(r => r.classification === "error").length,
  } : null;

  return (
    <div style={{ padding: 32 }}>
      <h2 style={{ marginTop: 0 }}>PLM / Licensee Import</h2>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button className={view === "import" ? "chip active" : "chip"} onClick={() => setView("import")}>Import</button>
        <button className={view === "history" ? "chip active" : "chip"} onClick={() => setView("history")}>Import History</button>
      </div>

      {view === "history" && <ImportHistoryPanel />}
      {view === "import" && (
        <>
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        <button className={source === "plm" ? "chip active" : "chip"} onClick={() => { setSource("plm"); setClassified(null); setFile(null); }}>Main PLM</button>
        <button className={source === "licensee" ? "chip active" : "chip"} onClick={() => { setSource("licensee"); setClassified(null); setFile(null); }}>Licensee</button>
        {source === "licensee" && <button onClick={downloadLicenseeTemplate} style={{ marginLeft: "auto" }}>Download Licensee Template</button>}
      </div>

      {source === "plm" && (
        <p style={{ fontSize: 12.5, color: "#6B7280", marginBottom: 12 }}>
          Upload the original PLM export exactly as received — no need to delete, reorder, or reduce columns.
          Required columns are detected by header name, wherever they appear in the file.
        </p>
      )}

      <input type="file" accept=".xlsx,.xls" onChange={handleFileChange} style={{ marginBottom: 12 }} />

      {sheetInfo && sheetInfo.requiresSelection && (
        <div style={{ background: "#FEF3C7", padding: 14, borderRadius: 8, marginBottom: 12 }}>
          <b>This workbook has {sheetInfo.sheets.length} sheets.</b> Select the one to import — only this sheet will be read, nothing else is combined.
          <div style={{ marginTop: 8 }}>
            {sheetInfo.sheets.map(s => (
              <label key={s.name} style={{ display: "block", marginTop: 4 }}>
                <input type="radio" checked={selectedSheet === s.name} onChange={() => setSelectedSheet(s.name)} />{" "}
                {s.name} {s.hasData ? `(looks like data — ${s.matchScore} known fields matched)` : "(no recognizable PLM columns)"}
              </label>
            ))}
          </div>
        </div>
      )}
      {sheetInfo && !sheetInfo.requiresSelection && (
        <p style={{ fontSize: 12, color: "#6B7280" }}>Sheet: {selectedSheet}</p>
      )}
      <button className="btn-primary" onClick={handleAnalyze} disabled={!file || !selectedSheet || parsing} style={{ marginLeft: 10 }}>
        {parsing ? "Analyzing..." : "Analyze"}
      </button>

      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
      {result && (
        <div style={{ background: result.wasCancelled ? "#FEF3C7" : "#DCFCE7", padding: 16, borderRadius: 8, marginTop: 16 }}>
          {result.wasCancelled
            ? <>Import cancelled after {result.groupsProcessed} of {result.totalGroups} orders were written — those {result.groupsProcessed} orders are real and already in the system; the rest were not processed. {result.newCount} new, {result.updatedCount} updated before cancelling.</>
            : <>Import confirmed: {result.newCount} new, {result.updatedCount} updated, {result.duplicateCount} duplicates skipped, {result.errorCount} errors.</>
          }{" "}
          <Link to="/orders">View Orders →</Link>
        </div>
      )}

      {parseResult && !result && (
        <p style={{ fontSize: 12, color: "#6B7280", marginTop: 12 }}>
          Sheet "{parseResult.sheetName}" — detected header on row {parseResult.headerRowIndex + 1} (matched {parseResult.matchScore} known fields). {parseResult.totalDataRows} data rows read.
        </p>
      )}

      {counts && (
        <>
          <div style={{ display: "flex", gap: 16, margin: "16px 0" }}>
            <div style={{ padding: 14, background: "#fff", borderRadius: 8 }}><b>{counts.total}</b> Total</div>
            <div style={{ padding: 14, background: "#DCFCE7", borderRadius: 8 }}><b>{counts.new}</b> New</div>
            <div style={{ padding: 14, background: "#FEF3C7", borderRadius: 8 }}><b>{counts.updated}</b> Updates</div>
            <div style={{ padding: 14, background: "#E0E7FF", borderRadius: 8 }}><b>{counts.duplicate}</b> Duplicates</div>
            <div style={{ padding: 14, background: "#FEE2E2", borderRadius: 8 }}><b>{counts.error}</b> Errors</div>
          </div>

          {/* Row-level preview, deliberately never aggregated -- every
              source row (one per color way) shown individually, per
              explicit instruction. */}
          <table className="data-table">
            <thead><tr><th>Row</th><th>PO</th><th>Style</th><th>Color Way</th><th>Qty</th><th>Status</th><th>Notes</th></tr></thead>
            <tbody>
              {classified.map((r, i) => (
                <tr key={i}>
                  <td>{r.sourceRowNumber}</td>
                  <td>{r.rawData.po_prefix}{r.rawData.po_number}</td>
                  <td>{r.rawData.style}</td>
                  <td>{r.rawData.color_way}</td>
                  <td>{r.rawData.qty}</td>
                  <td style={{
                    color: r.classification === "error" ? "#B91C1C" : r.classification === "updated" ? "#B45309" : r.classification === "duplicate" ? "#6B7280" : "#15803D",
                    fontWeight: 600,
                  }}>{r.classification}</td>
                  <td style={{ fontSize: 11.5, color: "#6B7280" }}>
                    {r.errors?.join("; ")}
                    {r.matched && [r.matched.division, r.matched.customer, r.matched.label, r.matched.businessUnit, r.matched.productGroup]
                      .filter(m => m?.warning).map((m, wi) => <div key={wi}>{m.warning}</div>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
            <button className="btn-primary" onClick={handleConfirm} disabled={importing || counts.error === counts.total}>
              {importing ? "Importing..." : `Confirm Import (${counts.new + counts.updated} rows will be written)`}
            </button>
            {importing && (
              <button className="btn-ghost-sm" onClick={handleCancelImport}>
                Cancel
              </button>
            )}
          </div>
          {importing && (
            <p className="muted-sm" style={{ marginTop: 6 }}>
              Cancelling stops the import going forward — any orders already written before you cancel stay in the system, since there's no safe way to undo them mid-import.
            </p>
          )}
        </>
      )}
        </>
      )}
    </div>
  );
}
