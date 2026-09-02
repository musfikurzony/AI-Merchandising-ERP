import React, { useEffect, useMemo, useState } from "react";
import { useOutletContext, Link, useSearchParams } from "react-router-dom";
import { getFilterOptions } from "../../lib/ordersApi.js";
import { seasonsIn } from "../../lib/reportsApi.js";
import {
  buildAdvisorDataset, AUDIENCES, defaultAudienceForRole, canSwitchAudience,
} from "../../lib/aiAssistantApi.js";
import {
  buildNotifications, summarise, startHere, workload, trend, movers,
  SEVERITY, SEVERITY_ORDER, NOTIFICATION_TYPES, EXPORT_COLUMNS, toExportRow,
} from "../../lib/notificationsApi.js";
import {
  loadOrganization, resolvePeriod, defaultPeriod, activeFilterLabels,
  DATE_BASIS_OPTIONS, reportFileName, formatGeneratedAt, exportHeaderBlock, orgTitleLine,
} from "../../lib/reportContext.js";
import ReportHeader from "../../components/ReportHeader.jsx";
import DataIntegrityNotice from "../../components/DataIntegrityNotice.jsx";
import ReportFilterBar from "../../components/ReportFilterBar.jsx";
import ExcelPreviewModal from "../../components/ExcelPreviewModal.jsx";
import { fmtCompact } from "../../lib/dateFormat.js";

/* ==========================================================================
   AI Assistant — Operational Control Tower
   ==========================================================================
   Four levels, deliberately, so the first screen stays readable at a glance
   while everything needed to act is one click away:

     Level 1  Operational health — how much is wrong, how badly.
              "Start here" names the five things that most need doing today,
              chosen by severity and size rather than a fixed category list.
     Level 2  Notification cards grouped under Critical / Attention /
              Warning: count, one line of explanation, and View all.
     Level 3  The detail list — every business field, paginated, each PO a
              link straight to the milestone that fixes it.
     Level 4  Excel, carrying a corporate header and exactly the rows on
              screen.

   Every figure comes from notificationsApi.js, which reads the same shared
   reporting engine every report reads. There is deliberately no second
   calculation path: if this screen said 18 overdue and Reports Center said
   17, management would stop trusting both. */

const EMPTY_FILTERS = {
  dateBasis: "etd", factoryCode: "", merchandiserId: "", customerCode: "",
  productGroupCode: "", labelCode: "", divisionCode: "", businessUnitCode: "",
  season: "", status: "", style: "", po: "",
};

const PAGE_SIZES = [25, 50, 100];

function fmtNum(n) { return n == null || n === "" ? "—" : Number(n).toLocaleString("en-US"); }

/* --- Level 1 ------------------------------------------------------------- */
function HealthStrip({ summary, generatedAt }) {
  const tiles = [
    { key: "critical", label: "Critical — act now", value: summary.bySeverity.critical, sub: `${summary.poCountBySeverity.critical} POs affected` },
    { key: "attention", label: "Attention this week", value: summary.bySeverity.attention, sub: `${summary.poCountBySeverity.attention} POs` },
    { key: "warning", label: "Upcoming risk", value: summary.bySeverity.warning, sub: `${summary.poCountBySeverity.warning} POs` },
    { key: "scope", label: "Orders in scope", value: summary.ordersInScope, sub: `${summary.totalNotifications} notifications` },
  ];
  return (
    <div className="ct-health">
      <div className="ct-health-head">
        <div>
          <div className="ct-eyebrow">Today · Operational control tower</div>
          <h3>{summary.bySeverity.critical > 0
            ? `${summary.poCountBySeverity.critical} PO${summary.poCountBySeverity.critical === 1 ? "" : "s"} need action today`
            : "Nothing critical open right now"}</h3>
        </div>
        <div className="ct-health-time">{generatedAt ? `as at ${formatGeneratedAt(generatedAt)}` : ""}</div>
      </div>
      <div className="ct-tiles">
        {tiles.map(t => (
          <div className={"ct-tile" + (t.key !== "scope" ? ` sev-${t.key}` : "")} key={t.key}>
            <div className="l">{t.key !== "scope" ? `${SEVERITY[t.key].dot} ` : ""}{t.label}</div>
            <div className="v">{fmtNum(t.value)}</div>
            <div className="s">{t.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* --- Level 2 ------------------------------------------------------------- */
/* A card is one notification type WITHIN one severity, not one type overall.
   The distinction matters: "ETD passed" holds rows that are critical (nothing
   shipped) and rows that are only attention (partly shipped). Filing the whole
   type under its worst row would make the section totals disagree with the
   health strip above it — the exact "Reports Center says 17, AI says 18"
   problem this screen exists to avoid. Grouping by row severity means every
   section total, and their sum, reconcile with the strip by construction. */
function TypeCard({ type, sev, rows, dateFormat, onViewAll, onExport }) {
  const meta = NOTIFICATION_TYPES[type];
  const preview = rows.slice(0, 5);
  const poCount = new Set(rows.map(r => r.po)).size;
  const qty = rows.reduce((a, r) => a + (r.orderQty || 0), 0);
  return (
    <div className={`ct-card sev-${sev}`}>
      <div className="ct-card-head">
        <span className="ct-card-title">{meta.label}</span>
        <span className="ct-count">{poCount} PO{poCount === 1 ? "" : "s"}</span>
      </div>
      <p className="ct-blurb">{meta.blurb}</p>
      <table className="rc-table ct-mini">
        <colgroup>
          <col style={{ width: "21%" }} /><col style={{ width: "17%" }} /><col style={{ width: "30%" }} />
          <col style={{ width: "16%" }} /><col style={{ width: "16%" }} />
        </colgroup>
        <thead>
          <tr><th>PO</th><th>Style</th><th>Factory</th><th style={{ textAlign: "right" }}>Qty</th><th>ETD</th></tr>
        </thead>
        <tbody>
          {preview.map(r => (
            <tr key={r.id}>
              <td><Link to={r.link} className="ai-po">{r.po}</Link></td>
              <td className="mono">{r.style}</td>
              <td className="f" title={r.factory}>{r.factory}</td>
              <td className="num">{fmtNum(r.orderQty)}</td>
              <td className="mono">{fmtCompact(r.revisedEtd || r.etd, dateFormat)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="ct-card-foot">
        <button className="btn-link" onClick={() => onViewAll(type, sev)}>View all {rows.length} →</button>
        <button className="btn-link" onClick={() => onExport(type, sev)}>Export Excel</button>
        <span className="spacer" />
        <span className="muted-sm">{fmtNum(qty)} pcs</span>
      </div>
    </div>
  );
}

export default function AiAssistant() {
  const { profile, dateFormat } = useOutletContext() || {};
  const role = profile?.role || "merchandiser";

  /* Arriving from a Dashboard tile. The Dashboard's whole promise is that a
     number is never a dead end, which means this screen has to be able to
     open already narrowed to the thing that was clicked. Read once, on
     mount: after that the user is driving. */
  const [searchParams] = useSearchParams();
  const initialType = searchParams.get("type");
  const initialSeverity = searchParams.get("severity");
  const initialCategories = searchParams.get("categories");
  const initialFactory = searchParams.get("factory");
  const initialMerchandiser = searchParams.get("merchandiser");

  const [org, setOrg] = useState(null);
  const [options, setOptions] = useState({});
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [period, setPeriod] = useState({ ...defaultPeriod(), mode: "all" });
  const [applied, setApplied] = useState(null);
  const [ds, setDs] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [generatedAt, setGeneratedAt] = useState(null);

  const [audience, setAudience] = useState(defaultAudienceForRole(role));
  const [onlyMine, setOnlyMine] = useState(role === "merchandiser");
  const [detailType, setDetailType] = useState(NOTIFICATION_TYPES[initialType] ? initialType : null);   // null = Level 2 (cards)
  const [detailFilter, setDetailFilter] = useState(
    initialFactory ? { dim: "factory", value: initialFactory }
    : initialMerchandiser ? { dim: "merchandiser", value: initialMerchandiser }
    : null
  );  // drill-down from a workload row
  const [detailSev, setDetailSev] = useState(SEVERITY[initialSeverity] ? initialSeverity : null);       // severity slice of a type
  const [showAll, setShowAll] = useState(Boolean(initialSeverity || initialCategories));   // "Detail list" with no type chosen
  const [detailCats, setDetailCats] = useState(initialCategories ? initialCategories.split(",") : null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [excelSheets, setExcelSheets] = useState(null);
  const [excelTitle, setExcelTitle] = useState("");
  const [workloadDim, setWorkloadDim] = useState("factory");
  const [trendStep, setTrendStep] = useState(7);   // 7d, 30d or 90d between points

  useEffect(() => {
    loadOrganization().then(setOrg);
    getFilterOptions().then(setOptions).catch(() => {});
  }, []);

  async function generate() {
    const resolved = resolvePeriod(period);
    const query = { ...filters, dateFrom: resolved.dateFrom, dateTo: resolved.dateTo };
    setLoading(true); setError(null);
    try {
      const result = await buildAdvisorDataset(query);
      setDs(result);
      setApplied({ ...query, periodLabel: resolved.label });
      setGeneratedAt(new Date());
      setDirty(false);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }
  useEffect(() => { generate(); /* eslint-disable-next-line */ }, []);

  const result = useMemo(
    () => ds ? buildNotifications(ds, { userId: profile?.id, onlyMine }) : null,
    [ds, onlyMine, profile?.id]
  );

  /* Audience scoping happens on the finished rows, not by re-running the
     engine — one computation, three views of it. */
  const audienceRows = useMemo(() => {
    if (!result) return [];
    return result.rows.filter(r => {
      const a = NOTIFICATION_TYPES[r.type].audience;
      if (audience === "management") return true;             // management sees everything
      return a === audience || a === "both";
    });
  }, [result, audience]);

  const scopedResult = useMemo(() => result ? { ...result, rows: audienceRows } : null, [result, audienceRows]);
  const summary = useMemo(() => scopedResult ? summarise(scopedResult) : null, [scopedResult]);
  const plan = useMemo(() => summary ? startHere(summary) : [], [summary]);
  const loads = useMemo(() => scopedResult ? workload(scopedResult, workloadDim) : [], [scopedResult, workloadDim]);
  const seasons = useMemo(() => ds ? seasonsIn(ds.orders) : [], [ds]);

  /* Phase 6 — the management trend. Four points, the same engine run with
     `today` moved back over the SAME loaded dataset, so a trend number and a
     card number can never come from different code. Computed only for the
     management view, where it is actually read. */
  const series = useMemo(() => {
    if (!ds || audience !== "management") return [];
    return trend(ds, { points: 4, stepDays: trendStep, userId: profile?.id, onlyMine });
  }, [ds, audience, trendStep, profile?.id, onlyMine]);
  const topMovers = useMemo(() => movers(series), [series]);

  const periodLabel = applied?.periodLabel || "";
  const dateBasisLabel = (DATE_BASIS_OPTIONS.find(d => d[0] === (applied?.dateBasis || "etd")) || [])[1];
  const filterLabels = applied ? activeFilterLabels(applied, options) : [];

  const rowsByType = useMemo(() => {
    const m = new Map();
    for (const r of audienceRows) {
      if (!m.has(r.type)) m.set(r.type, []);
      m.get(r.type).push(r);
    }
    return m;
  }, [audienceRows]);

  /* Cards are grouped by ROW severity first, then by type, so that each
     section's totals add up to the health strip above it. */
  const sevTypeGroups = useMemo(() => {
    const m = { critical: new Map(), attention: new Map(), warning: new Map(), normal: new Map() };
    for (const r of audienceRows) {
      const g = m[r.severity];
      if (!g) continue;
      if (!g.has(r.type)) g.set(r.type, []);
      g.get(r.type).push(r);
    }
    return m;
  }, [audienceRows]);

  /* --- Level 3: the detail list ---------------------------------------- */
  const detailRows = useMemo(() => {
    let rows = detailType ? (rowsByType.get(detailType) || []) : audienceRows;
    if (detailSev) rows = rows.filter(r => r.severity === detailSev);
    if (detailCats) rows = rows.filter(r => detailCats.includes(NOTIFICATION_TYPES[r.type].category));
    if (detailFilter) {
      rows = rows.filter(r => (detailFilter.dim === "factory" ? r.factory : r.merchandiser) === detailFilter.value);
    }
    return rows;
  }, [detailType, detailSev, detailCats, detailFilter, rowsByType, audienceRows]);

  const pageCount = Math.max(1, Math.ceil(detailRows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const pageRows = detailRows.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  useEffect(() => { setPage(1); }, [detailType, detailSev, detailFilter, showAll, pageSize, audience, onlyMine]);

  /* --- Level 4: Excel, exactly the rows currently filtered -------------- */
  /* The corporate header comes from the shared builder in reportContext,
     so this screen's exports and the Dashboard's are identical by
     construction rather than by two functions agreeing. */
  const excelHeaderBlock = (reportName) => exportHeaderBlock({
    org, reportName, periodLabel, dateBasisLabel, filters, options,
    viewLabel: `${(AUDIENCES.find(a => a[0] === audience) || [])[1]}${onlyMine ? " · only my orders" : ""}`,
    generatedAt, generatedBy: profile?.full_name || "",
  });

  function exportRows(rows, reportName) {
    setExcelTitle(reportName);
    setExcelSheets([{
      name: reportName.slice(0, 28),
      header: excelHeaderBlock(reportName),
      columns: EXPORT_COLUMNS.map(([, header]) => header),
      rows: rows.map(toExportRow),
      totals: { "Notification Type": "Total", "PO": `${new Set(rows.map(r => r.po)).size} POs`, "Order Qty": rows.reduce((s, r) => s + (r.orderQty || 0), 0) },
    }]);
  }
  const exportType = (type, sev) => exportRows(
    (rowsByType.get(type) || []).filter(r => !sev || r.severity === sev),
    NOTIFICATION_TYPES[type].label + (sev ? ` — ${SEVERITY[sev].label}` : ""));
  const detailTitle = (detailType ? NOTIFICATION_TYPES[detailType].label : "All notifications")
    + (detailSev ? ` — ${SEVERITY[detailSev].label}` : "");

  const exportCurrent = () => exportRows(detailRows, detailTitle === "All notifications" ? "All operational notifications" : detailTitle);
  const inDetail = Boolean(detailType || detailFilter || showAll || detailCats);
  const backToSummary = () => { setDetailType(null); setDetailSev(null); setDetailCats(null); setDetailFilter(null); setShowAll(false); };

  return (
    <div className="rc-page">
      <ReportHeader
        org={org}
        title="AI Assistant — Operational Control Tower"
        subtitle="What needs attention today, why it matters, who is responsible, and what to do next — computed from live orders, milestones, CRDs and shipments"
        periodLabel={periodLabel}
        dateBasisLabel={dateBasisLabel}
        generatedAt={generatedAt}
        generatedBy={profile?.full_name}
        filterLabels={filterLabels}
        recordCount={summary?.ordersInScope}
        recordNoun="orders in scope"
        right={<>
          <button className="btn-outline" onClick={generate} disabled={loading}>{loading ? "Checking…" : "Re-check now"}</button>
          <button className="btn-amber" onClick={exportCurrent} disabled={!summary}>Export Excel</button>
        </>}
      />

      <DataIntegrityNotice integrity={ds?.integrity} />
      {error && <div className="bk-note warn" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="rc-card ai-viewbar" style={{ marginBottom: 18 }}>
        {canSwitchAudience(role) ? (
          <div className="rpt-field">
            <span className="field-label">Viewing as</span>
            <div className="seg">
              {AUDIENCES.map(([k, l]) => (
                <button key={k} className={audience === k ? "active" : ""} onClick={() => setAudience(k)}>{l}</button>
              ))}
            </div>
          </div>
        ) : (
          <div className="rpt-field">
            <span className="field-label">Your view</span>
            <div style={{ fontSize: 13, fontWeight: 600, padding: "7px 0" }}>{(AUDIENCES.find(a => a[0] === audience) || [])[1]}</div>
          </div>
        )}
        <div className="rpt-field" style={{ maxWidth: 340 }}>
          <span className="field-label">Scope</span>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, padding: "7px 0" }}>
            <input type="checkbox" checked={onlyMine} onChange={e => setOnlyMine(e.target.checked)} style={{ accentColor: "var(--pei-amber)", width: 15, height: 15 }} />
            Only orders where I'm the primary merchandiser
          </label>
        </div>
        <div className="rpt-field">
          <span className="field-label">Level</span>
          <div className="seg">
            <button className={!inDetail ? "active" : ""} onClick={backToSummary}>Summary</button>
            <button className={inDetail ? "active" : ""} onClick={() => { setShowAll(true); setDetailSev(null); }}>Detail list</button>
          </div>
        </div>
        <p className="rpt-hint" style={{ maxWidth: 360 }}>
          Every figure is computed from your own data by the same engine the reports use. A PO is a link — it opens the exact milestone that fixes it.
        </p>
      </div>

      <ReportFilterBar
        filters={filters} onFilters={f => { setFilters(f); setDirty(true); }}
        period={period} onPeriod={p => { setPeriod(p); setDirty(true); }}
        options={options} seasons={seasons}
        showGrouping={false}
        onGenerate={generate} loading={loading} dirty={dirty} generateLabel="Apply filters"
      />

      {loading && !summary && <div className="rc-card">Reading orders, milestones, CRDs and shipments…</div>}

      {summary && (
        <>
          <HealthStrip summary={summary} generatedAt={generatedAt} />

          {/* --- Start here ------------------------------------------- */}
          <div className="ct-start">
            <div className="ct-start-head">
              <span className="ct-eyebrow">Start here</span>
              <h4>{plan.length ? `${plan.length} things need you today` : "Nothing needs chasing right now"}</h4>
            </div>
            {plan.length === 0 ? (
              <p className="ct-start-empty">No overdue milestones, missed ETDs or unassigned factories in this selection.</p>
            ) : (
              <ol className="ct-start-list">
                {plan.map(p => (
                  <li key={p.type} className={`sev-${p.severity}`} onClick={() => { setDetailType(p.type); setDetailSev(null); setDetailFilter(null); setShowAll(false); }}>
                    <span className="n">{p.n}</span>
                    <span className="t">{SEVERITY[p.severity].dot} <strong>{p.poCount} PO{p.poCount === 1 ? "" : "s"}</strong> — {p.label}</span>
                    <span className="q">{fmtNum(p.qty)} pcs</span>
                    <span className="go">View →</span>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {/* --- Level 2: cards by severity, or Level 3: the list ------ */}
          {!inDetail ? (
            <>
              {SEVERITY_ORDER.filter(s => s !== "normal").map(sev => {
                const entries = [...sevTypeGroups[sev].entries()].sort((a, b) => b[1].length - a[1].length);
                if (!entries.length) return null;
                const distinctPos = new Set();
                for (const [, rows] of entries) for (const r of rows) distinctPos.add(r.po);
                const notifications = entries.reduce((a, [, rows]) => a + rows.length, 0);
                return (
                  <div key={sev} className="ct-section">
                    <div className="ct-section-head">
                      <span className={`ct-sev-title sev-${sev}`}>{SEVERITY[sev].dot} {SEVERITY[sev].label}</span>
                      <span className="muted-sm">
                        {notifications} notification{notifications === 1 ? "" : "s"} · {distinctPos.size} PO{distinctPos.size === 1 ? "" : "s"} · {entries.length} categor{entries.length === 1 ? "y" : "ies"}
                      </span>
                    </div>
                    <div className="ct-grid">
                      {entries.map(([type, rows]) => (
                        <TypeCard key={type} type={type} sev={sev} rows={rows} dateFormat={dateFormat}
                          onViewAll={(ty, sv) => { setDetailType(ty); setDetailSev(sv); setDetailFilter(null); setShowAll(false); }}
                          onExport={exportType} />
                      ))}
                    </div>
                  </div>
                );
              })}

              {/* --- Phase 6: management trend ---------------------- */}
              {audience === "management" && series.length > 1 && (() => {
                const now = series[series.length - 1], prev = series[series.length - 2];
                const stepLabel = trendStep === 7 ? "week" : trendStep === 30 ? "month" : "quarter";
                const delta = (a, b) => {
                  const d = a - b;
                  return <span className={"ct-delta " + (d > 0 ? "up" : d < 0 ? "down" : "flat")}>{d > 0 ? "▲" : d < 0 ? "▼" : "="} {d === 0 ? "no change" : `${Math.abs(d).toLocaleString()} vs last ${stepLabel}`}</span>;
                };
                const METRICS = [
                  ["🔴 Critical", "critical"], ["🟠 Attention", "attention"], ["🟡 Warning", "warning"],
                  ["POs at risk", "posAtRisk"], ["All notifications", "total"],
                ];
                return (
                  <div className="rc-card no-pad" style={{ marginTop: 18 }}>
                    <div className="rc-card-head" style={{ padding: "18px 18px 0", marginBottom: 10 }}>
                      <span className="rc-card-title">Direction of travel — is the book getting better or worse?</span>
                      <div className="seg" style={{ marginLeft: "auto" }}>
                        <button className={trendStep === 7 ? "active" : ""} onClick={() => setTrendStep(7)}>Weekly</button>
                        <button className={trendStep === 30 ? "active" : ""} onClick={() => setTrendStep(30)}>Monthly</button>
                        <button className={trendStep === 90 ? "active" : ""} onClick={() => setTrendStep(90)}>Quarterly</button>
                      </div>
                    </div>
                    <div className="rc-scroll">
                      <table className="rc-table">
                        <thead>
                          <tr>
                            <th>Measure</th>
                            {series.map(pt => <th key={pt.asAt} style={{ textAlign: "right" }}>{pt.label}</th>)}
                            <th>Movement</th>
                          </tr>
                        </thead>
                        <tbody>
                          {METRICS.map(([label, key]) => (
                            <tr key={key}>
                              <td><strong>{label}</strong></td>
                              {series.map(pt => <td key={pt.asAt} className="num">{fmtNum(pt[key])}</td>)}
                              <td>{delta(now[key], prev[key])}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {topMovers.length > 0 && (
                      <div style={{ padding: "4px 18px 16px" }}>
                        <div className="ct-eyebrow" style={{ marginBottom: 8 }}>What moved</div>
                        <ul className="ct-movers">
                          {topMovers.map(m => (
                            <li key={m.type}>
                              <span className={"ct-delta " + (m.delta > 0 ? "up" : "down")}>{m.delta > 0 ? "▲" : "▼"} {Math.abs(m.delta)}</span>
                              <button className="btn-link" onClick={() => { setDetailType(m.type); setDetailSev(null); setDetailFilter(null); setShowAll(false); }}>{m.label}</button>
                              <span className="muted-sm">{m.prev} → {m.now}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <p className="bk-note" style={{ margin: "0 18px 16px" }}>
                      Each column is this same engine run with the date moved back over today's records. Date-driven
                      exposure (overdue, closing in, CRD history) is exact; approval backlogs read optimistically,
                      because the ERP stores one actual date per milestone rather than a history of it.
                    </p>
                  </div>
                );
              })()}

              {/* --- workload --------------------------------------- */}
              <div className="rc-card no-pad" style={{ marginTop: 18 }}>
                <div className="rc-card-head" style={{ padding: "18px 18px 0", marginBottom: 10 }}>
                  <span className="rc-card-title">Workload — who has to act</span>
                  <div className="seg" style={{ marginLeft: "auto" }}>
                    <button className={workloadDim === "factory" ? "active" : ""} onClick={() => setWorkloadDim("factory")}>By factory</button>
                    <button className={workloadDim === "merchandiser" ? "active" : ""} onClick={() => setWorkloadDim("merchandiser")}>By merchandiser</button>
                  </div>
                </div>
                <div className="rc-scroll">
                  <table className="rc-table">
                    <thead>
                      <tr>
                        <th>{workloadDim === "factory" ? "Factory" : "Merchandiser"}</th>
                        <th style={{ textAlign: "right" }}>POs</th>
                        <th style={{ textAlign: "right" }}>🔴 Critical</th>
                        <th style={{ textAlign: "right" }}>🟠 Attention</th>
                        <th style={{ textAlign: "right" }}>🟡 Warning</th>
                        <th style={{ textAlign: "right" }}>Overdue</th>
                        <th style={{ textAlign: "right" }}>Due ≤7d</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {loads.map(w => (
                        <tr key={w.label}>
                          <td className="strong">{w.label}</td>
                          <td className="num">{w.poCount}</td>
                          <td className="num">{w.critical || "—"}</td>
                          <td className="num">{w.attention || "—"}</td>
                          <td className="num">{w.warning || "—"}</td>
                          <td className="num">{w.overdue || "—"}</td>
                          <td className="num">{w.due7 || "—"}</td>
                          <td><button className="btn-link" onClick={() => { setDetailFilter({ dim: workloadDim, value: w.label }); setDetailType(null); setDetailSev(null); setShowAll(false); }}>Drill down →</button></td>
                        </tr>
                      ))}
                      {loads.length === 0 && <tr><td colSpan={8} className="empty-row">Nothing outstanding in this selection.</td></tr>}
                    </tbody>
                    {loads.length > 0 && (
                      <tfoot>
                        <tr>
                          <td>Total</td>
                          {/* Distinct POs, not the sum of the severity PO counts:
                              one PO can be critical for one reason and only a
                              warning for another, and adding those columns would
                              report more POs than the business has. */}
                          <td className="num">{loads.reduce((s, w) => s + w.poCount, 0)}</td>
                          <td className="num">{summary.bySeverity.critical}</td>
                          <td className="num">{summary.bySeverity.attention}</td>
                          <td className="num">{summary.bySeverity.warning}</td>
                          <td className="num">{loads.reduce((s, w) => s + w.overdue, 0)}</td>
                          <td className="num">{loads.reduce((s, w) => s + w.due7, 0)}</td>
                          <td />
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>
            </>
          ) : (
            /* --- Level 3: the detail list -------------------------- */
            <div className="rc-card no-pad">
              <div className="rc-card-head" style={{ padding: "18px 18px 0", marginBottom: 10, flexWrap: "wrap" }}>
                <span className="rc-card-title">
                  {detailTitle}
                  {detailFilter && <span className="rc-badge neutral" style={{ marginLeft: 10 }}>{detailFilter.dim === "factory" ? "Factory" : "Merchandiser"}: {detailFilter.value}</span>}
                </span>
                <span className="rc-card-note">{detailRows.length.toLocaleString()} notifications</span>
                <button className="btn-outline" onClick={backToSummary}>← Back to summary</button>
                <button className="btn-amber" onClick={exportCurrent}>Export Excel</button>
              </div>

              <div className="rc-scroll">
                <table className="rc-table ct-detail">
                  <thead>
                    <tr>
                      <th>Severity</th><th>Type</th><th>PO</th><th>Style</th><th>Colour</th>
                      <th>Product group</th><th>Label</th><th>Customer</th><th>Factory</th><th>Merchandiser</th>
                      <th style={{ textAlign: "right" }}>Order qty</th>
                      <th>Order rcv</th><th>Prod start</th><th>Milestone</th><th>Planned</th><th>Actual</th>
                      <th>ETD</th><th>Rev ETD</th>
                      <th style={{ textAlign: "right" }}>Days over</th>
                      <th style={{ textAlign: "right" }}>Days left</th>
                      <th>Status</th><th>What to do</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map(r => (
                      <tr key={r.id}>
                        <td><span className={"rc-badge " + SEVERITY[r.severity].badge}>{SEVERITY[r.severity].dot} {SEVERITY[r.severity].label}</span></td>
                        <td>{r.typeLabel}</td>
                        <td><Link to={r.link} className="ai-po">{r.po}</Link></td>
                        <td className="mono">{r.style}</td>
                        <td>{r.color || "—"}</td>
                        <td>{r.productGroup || "—"}</td>
                        <td>{r.label || "—"}</td>
                        <td>{r.customer || "—"}</td>
                        <td>{r.factory}</td>
                        <td>{r.merchandiser}</td>
                        <td className="num">{fmtNum(r.orderQty)}</td>
                        <td className="mono">{fmtCompact(r.orderRcvDate, dateFormat)}</td>
                        <td className="mono">{fmtCompact(r.productionStartDate, dateFormat)}</td>
                        <td>{r.milestone || "—"}</td>
                        <td className="mono">{fmtCompact(r.plannedDate, dateFormat)}</td>
                        <td className="mono">{fmtCompact(r.actualDate, dateFormat)}</td>
                        <td className="mono">{fmtCompact(r.etd, dateFormat)}</td>
                        <td className="mono">{fmtCompact(r.revisedEtd, dateFormat)}</td>
                        <td className="num">{r.daysDelayed != null ? <span className="rc-badge bad">+{r.daysDelayed}d</span> : "—"}</td>
                        <td className="num">{r.daysRemaining != null ? `${r.daysRemaining}d` : "—"}</td>
                        <td>{r.currentStatus}</td>
                        <td style={{ minWidth: 320, color: "var(--pei-muted)" }}>{r.recommendedAction}</td>
                      </tr>
                    ))}
                    {pageRows.length === 0 && <tr><td colSpan={22} className="empty-row">Nothing in this category for the current filters.</td></tr>}
                  </tbody>
                </table>
              </div>

              {/* --- pagination ------------------------------------- */}
              <div className="ct-pager">
                <span className="muted-sm">
                  Showing {detailRows.length === 0 ? 0 : (currentPage - 1) * pageSize + 1}–{Math.min(currentPage * pageSize, detailRows.length)} of {detailRows.length.toLocaleString()}
                </span>
                <span className="spacer" />
                <span className="muted-sm">Rows per page</span>
                <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))}>
                  {PAGE_SIZES.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <button className="btn-outline" disabled={currentPage <= 1} onClick={() => setPage(1)}>First</button>
                <button className="btn-outline" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous</button>
                <span className="muted-sm">Page {currentPage} of {pageCount}</span>
                <button className="btn-outline" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}>Next</button>
                <button className="btn-outline" disabled={currentPage >= pageCount} onClick={() => setPage(pageCount)}>Last</button>
              </div>
            </div>
          )}

          {result?.unavailable?.length > 0 && (
            <div className="bk-note" style={{ marginTop: 18 }}>
              <strong>Checks that couldn't run against your T&amp;A setup:</strong>
              <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                {result.unavailable.map(u => (
                  <li key={u.type} style={{ marginBottom: 4 }}>
                    <strong>{NOTIFICATION_TYPES[u.type]?.label || u.type}</strong> — {u.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {excelSheets && (
        <ExcelPreviewModal
          title={excelTitle}
          subtitle={orgTitleLine(org)}
          meta={`${periodLabel || "All time"} · ${dateBasisLabel} · exactly the rows currently filtered`}
          sheets={excelSheets}
          fileName={reportFileName(org, excelTitle, periodLabel, "xlsx")}
          onClose={() => setExcelSheets(null)}
        />
      )}
    </div>
  );
}
