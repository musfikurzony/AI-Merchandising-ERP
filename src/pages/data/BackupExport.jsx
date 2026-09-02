import React, { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import {
  BACKUP_CATEGORIES, BACKUP_DATASETS, datasetsByCategory, isScopable,
  countAll, runExport, toSheets, buildManifest, downloadJsonBackup, estimateSize,
} from "../../lib/backupApi.js";
import { seasonsIn } from "../../lib/reportsApi.js";
import { getFilterOptions } from "../../lib/ordersApi.js";
import ReportFilterBar from "../../components/ReportFilterBar.jsx";
import { hasModulePermission } from "../../lib/permissions.js";
import {
  loadOrganization, reportFileName, resolvePeriod, defaultPeriod, activeFilterLabels,
} from "../../lib/reportContext.js";
import { copyToClipboard } from "../../lib/exportPreview.js";
import ReportHeader from "../../components/ReportHeader.jsx";
import ExcelPreviewModal from "../../components/ExcelPreviewModal.jsx";

/* Backup & Export.

   Deliberate design decisions, in the order they matter:

   - It says plainly what it is. This exports what the SIGNED-IN USER can
     read, through the app's own API and RLS. It is not a database backup
     and does not pretend to be one; the screen names Supabase's scheduled
     backups as the thing that actually protects against data loss.

   - Every export is RECONCILED. Each dataset's exported row count is
     checked against a separate exact COUNT from the database, and any
     mismatch is shown as a failed reconciliation rather than quietly
     producing a short file that looks complete.

   - Nothing downloads on click. Consistent with the rest of the app since
     v80: Excel opens as a readable preview first; the JSON backup states
     its size and row count before it is written.

   - Permission: this reuses the existing module-permission mechanism
     rather than inventing a new one. If a 'backup_export' module key
     exists it governs the screen; until that key is seeded (proposed
     migration 36 ships with this round) it falls back to requiring
     Administration access, so the screen is never accidentally open to
     everyone. */

function fmt(n) { return n == null ? "—" : Number(n).toLocaleString("en-US"); }

export default function BackupExport() {
  const { profile } = useOutletContext() || {};
  const [org, setOrg] = useState(null);
  const [allowed, setAllowed] = useState(null);      // null = still checking
  const [permissionSource, setPermissionSource] = useState("");
  const [counts, setCounts] = useState({});
  const [options, setOptions] = useState({});
  const [filters, setFilters] = useState({
    dateBasis: "etd", factoryCode: "", merchandiserId: "", customerCode: "",
    productGroupCode: "", labelCode: "", divisionCode: "", businessUnitCode: "",
    season: "", status: "", style: "", po: "",
  });
  // Defaults to "all time" deliberately: a backup that silently covered only
  // this fiscal year would be the worst kind of wrong.
  const [period, setPeriod] = useState({ ...defaultPeriod(), mode: "all" });
  const [selected, setSelected] = useState(() => new Set(["order_book_colour", "shipment_lines_detail"]));
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState(null);
  const [sheets, setSheets] = useState(null);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadOrganization().then(setOrg);
    getFilterOptions().then(setOptions).catch(() => {});
    (async () => {
      try {
        const viaModule = await hasModulePermission("backup_export", "view").catch(() => false);
        if (viaModule) { setAllowed(true); setPermissionSource("backup_export module permission"); return; }
        const viaAdmin = await hasModulePermission("administration", "view").catch(() => false);
        setAllowed(viaAdmin);
        setPermissionSource(viaAdmin ? "Administration access (backup_export key not seeded yet)" : "");
      } catch { setAllowed(false); }
    })();
  }, []);

  useEffect(() => {
    if (allowed !== true) return;
    countAll(BACKUP_DATASETS.map(d => d.key), {}).then(setCounts).catch(e => setError(e.message));
  }, [allowed]);

  function toggle(key) {
    setSelected(s => {
      const next = new Set(s);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }
  function toggleCategory(category) {
    const keys = datasetsByCategory(category).map(d => d.key);
    const allOn = keys.every(k => selected.has(k));
    setSelected(s => {
      const next = new Set(s);
      keys.forEach(k => allOn ? next.delete(k) : next.add(k));
      return next;
    });
  }

  async function doExport() {
    setBusy(true); setError(null); setResult(null); setProgress("Resolving scope…");
    const resolved = resolvePeriod(period);
    const scopedFilters = { ...filters, dateFrom: resolved.dateFrom, dateTo: resolved.dateTo };
    try {
      const { datasets, scope } = await runExport([...selected], {
        filters: scopedFilters,
        onProgress: (label, n) => setProgress(n ? `Reading ${label}… ${n.toLocaleString()} rows` : label),
      });
      const filterLabels = activeFilterLabels(scopedFilters, options);
      setResult({
        datasets, scope,
        periodLabel: resolved.label,
        filterLabels,
        manifest: buildManifest(datasets, { org, user: profile, periodLabel: resolved.label, filterLabels, scope }),
        size: estimateSize(datasets),
      });
      setProgress("");
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  const selectedCount = selected.size;
  const selectedRows = [...selected].reduce((s, k) => s + (counts[k]?.count || 0), 0);
  const selectedComposites = [...selected].filter(k => (BACKUP_DATASETS.find(d => d.key === k) || {}).scope === "composite").length;
  const failures = (result?.datasets || []).filter(d => d.error || d.reconciled === false);

  if (allowed === null) return <div className="rc-page"><div className="rc-card">Checking your permissions…</div></div>;
  if (allowed === false) {
    return (
      <div className="rc-page">
        <div className="rc-card">
          <h2 style={{ marginTop: 0 }}>Backup &amp; Export</h2>
          <p className="muted-sm">
            You don't have permission to export data. This screen requires the <strong>Backup &amp; Export</strong> module
            permission (or Administration access until that permission is seeded). Ask an Administrator if you need it.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rc-page">
      <ReportHeader
        org={org}
        title="Backup & Export"
        subtitle="Controlled data export — read through the app's own permissions, reconciled against the database, previewed before anything is written"
        generatedAt={new Date()}
        generatedBy={profile?.full_name}
        periodLabel={result?.periodLabel || resolvePeriod(period).label}
        right={<>
          <button className="btn-outline" onClick={doExport} disabled={busy || selectedCount === 0}>
            {busy ? "Working…" : "Prepare export"}
          </button>
          <button className="btn-amber" disabled={!result} onClick={() => setSheets(toSheets(result.datasets))}>
            Preview &amp; export Excel
          </button>
          <button className="btn-outline" disabled={!result}
            onClick={() => downloadJsonBackup(result.datasets, result.manifest, reportFileName(org, "Data Backup", result?.periodLabel || "", "json"))}>
            Download JSON backup
          </button>
        </>}
      />

      <div className="bk-note" style={{ marginBottom: 18 }}>
        <strong>What this is.</strong> A data export taken through the application as <strong>{profile?.full_name || "you"}</strong>
        {permissionSource ? ` (${permissionSource})` : ""}. Row Level Security applies, so it contains exactly the rows you are
        allowed to read — which is correct, and also means it is <strong>not</strong> a full database dump.
        <br />
        <strong>What protects you from data loss</strong> is Supabase's own scheduled backup of the project (Dashboard → Database →
        Backups), or a <code>pg_dump</code>. This screen is for taking data <em>out</em> — for audit, for offline analysis, for handing
        a dataset to Finance — not for disaster recovery. Restoring from the JSON file is not a feature of this module and is not
        implied anywhere in it.
      </div>

      {error && <div className="bk-note warn" style={{ marginBottom: 18 }}>{error}</div>}

      {/* Period + filter scoping. Applies to the order-derived datasets
          (the colour-level order book, orders, colour ways, milestones, CRD
          updates, shipment lines) — master data and administration tables
          are always exported whole, since a "customers" list filtered by an
          order date range would be a strange thing to hand anyone. */}
      <ReportFilterBar
        filters={filters} onFilters={setFilters}
        period={period} onPeriod={setPeriod}
        options={options} seasons={[]}
        showGrouping={false}
        onGenerate={doExport} loading={busy} dirty={!result} generateLabel="Apply scope & prepare"
      />
      <p className="muted-sm" style={{ margin: "-6px 2px 18px" }}>
        The period and filters above scope every dataset marked <strong>scopable</strong>. Child tables are filtered
        <strong> by their parent orders</strong>, never by their own dates — so a milestone or shipment line can never
        end up in the file without the order it belongs to.
      </p>

      {/* --- pick what to export ----------------------------------------- */}
      {BACKUP_CATEGORIES.map(category => {
        const items = datasetsByCategory(category);
        const allOn = items.every(d => selected.has(d.key));
        return (
          <div className="rc-card" key={category} style={{ marginBottom: 14 }}>
            <div className="rc-card-head">
              <span className="rc-card-title">{category}</span>
              <span className="rc-card-note">
                {items.filter(d => selected.has(d.key)).length} of {items.length} selected
              </span>
              <button className="btn-link" onClick={() => toggleCategory(category)}>{allOn ? "Clear all" : "Select all"}</button>
            </div>
            <div className="bk-grid">
              {items.map(d => (
                <label className={"bk-item" + (selected.has(d.key) ? " on" : "")} key={d.key}>
                  <input type="checkbox" checked={selected.has(d.key)} onChange={() => toggle(d.key)} />
                  <span>
                    <span className="n">{d.label}</span>
                    <span className="d">{d.description}</span>
                    <span className="c">
                      {isScopable(d) && <span className="rc-badge neutral" style={{ marginRight: 6, fontSize: 10 }}>scopable</span>}
                      {d.scope === "composite"
                        ? "built from the orders in scope"
                        : counts[d.key]?.error
                        ? <span style={{ color: "var(--pei-bad-fg)" }}>not readable — {counts[d.key].error}</span>
                        : counts[d.key]
                          ? `${fmt(counts[d.key].count)} rows visible to you`
                          : "counting…"}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        );
      })}

      <div className="rc-card" style={{ marginBottom: 18, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12.5, color: "var(--pei-muted)" }}>Selected for export</div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>
            {selectedCount} dataset{selectedCount === 1 ? "" : "s"}
            {selectedRows > 0 ? ` · ~${fmt(selectedRows)} table rows` : ""}
            {selectedComposites ? ` · ${selectedComposites} built from the orders in scope` : ""}
          </div>
        </div>
        {busy && <div className="muted-sm">{progress}</div>}
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button className="btn-amber" onClick={doExport} disabled={busy || selectedCount === 0}>
            {busy ? "Working…" : result ? "Re-read data" : "Prepare export"}
          </button>
        </div>
      </div>

      {/* --- what actually came back ------------------------------------- */}
      {result && (
        <div className="rc-card no-pad">
          <div className="rc-card-head" style={{ padding: "18px 18px 0", marginBottom: 10 }}>
            <span className="rc-card-title">Export manifest</span>
            <span className="rc-card-note">
              rows exported vs rows the database says you can see · approx. {result.size}
            </span>
          </div>

          {failures.length > 0 && (
            <div className="bk-note warn" style={{ margin: "0 18px 12px" }}>
              <strong>{failures.length} dataset{failures.length === 1 ? "" : "s"} did not reconcile.</strong> The export is
              incomplete for {failures.map(f => f.label).join(", ")} — check the reason in the table below before relying on
              this file.
            </div>
          )}

          <div className="rc-scroll">
            <table className="rc-table">
              <thead>
                <tr>
                  <th>Dataset</th><th>Table</th><th>Scope</th>
                  <th style={{ textAlign: "right" }}>Rows exported</th>
                  <th style={{ textAlign: "right" }}>Rows in scope (DB)</th>
                  <th>Reconciled</th>
                </tr>
              </thead>
              <tbody>
                {result.datasets.map(d => (
                  <tr key={d.key}>
                    <td className="strong">{d.label}</td>
                    <td className="mono" style={{ color: "var(--pei-muted)" }}>{d.table}</td>
                    <td>{d.derived ? "derived from orders in scope" : d.scoped ? "period + filters applied" : "whole table"}</td>
                    <td className="num">{fmt(d.rowCount)}</td>
                    <td className="num">{fmt(d.expected)}</td>
                    <td>
                      {d.error
                        ? <span className="rc-badge bad">failed — {d.error}</span>
                        : d.derived
                        ? <span className="rc-badge neutral">derived — built from {fmt(result.orderCount ?? d.expected)} orders</span>
                        : d.reconciled === false
                          ? <span className="rc-badge bad">✗ mismatch</span>
                          : d.reconciled === true
                            ? <span className="rc-badge good">✓ exact match</span>
                            : <span className="rc-badge neutral">count unavailable</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>Total — {result.datasets.length} datasets</td>
                  <td className="num">{fmt(result.manifest.total_rows_exported)}</td>
                  <td className="num">{fmt(result.datasets.reduce((s, d) => s + (d.expected || 0), 0))}</td>
                  <td>{failures.length === 0 ? <span className="rc-badge good">✓ all reconciled</span> : <span className="rc-badge bad">{failures.length} failed</span>}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div style={{ display: "flex", gap: 8, padding: 18, flexWrap: "wrap", alignItems: "center" }}>
            <button className="btn-amber" onClick={() => setSheets(toSheets(result.datasets))}>Preview &amp; export Excel</button>
            <button className="btn-outline"
              onClick={() => downloadJsonBackup(result.datasets, result.manifest, reportFileName(org, "Data Backup", result?.periodLabel || "", "json"))}>
              Download JSON backup (~{result.size})
            </button>
            <button className="btn-outline" onClick={async () => {
              const ok = await copyToClipboard(JSON.stringify(result.manifest, null, 2));
              setCopied(ok); setTimeout(() => setCopied(false), 3000);
            }}>Copy manifest</button>
            {copied && <span className="muted-sm" style={{ color: "var(--pei-good-fg)", fontWeight: 600 }}>Manifest copied</span>}
            <span className="muted-sm" style={{ marginLeft: "auto", maxWidth: 440 }}>
              Period: <strong>{result.periodLabel}</strong>{result.filterLabels.length ? ` · ${result.filterLabels.join(" · ")}` : " · no filters"}.
              The JSON file keeps nested structures intact; the Excel sheets flatten them to text so nothing is lost in a cell.
            </span>
          </div>
        </div>
      )}

      {sheets && (
        <ExcelPreviewModal
          title="Data export"
          subtitle={[org?.company_name, org?.branch].filter(Boolean).join(" · ")}
          meta={`${result.datasets.length} datasets · ${fmt(result.manifest.total_rows_exported)} rows · exported as ${profile?.full_name || "current user"}`}
          sheets={sheets}
          fileName={reportFileName(org, "Data Export", result?.periodLabel || "", "xlsx")}
          onClose={() => setSheets(null)}
        />
      )}
    </div>
  );
}
