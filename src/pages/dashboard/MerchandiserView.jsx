import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { merchandiserTiles, todayBlock, onTrackPos, groupRowsByType } from "../../lib/dashboardApi.js";
import { NOTIFICATION_TYPES, SEVERITY } from "../../lib/notificationsApi.js";
import { KpiStrip, MyActions, TodayBlock, ActionTable, Pager, QuickActions, SectionHead } from "./parts.jsx";

/* ==========================================================================
   The merchandiser's landing page.
   ==========================================================================
   One question: which of my orders need me today? So the screen is ordered
   by how a merchandiser actually works — how much is on my desk, what is
   burning, then the list itself with a link straight to the milestone that
   fixes each one. No business figures they cannot act on.

   The rows here are the notification engine's rows, unmodified. Nothing on
   this page decides what "overdue" means. */

export default function MerchandiserView({ ds, rows, summary, plan, dateFormat, modules, scope, onExport, periodLabel }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [typeFilter, setTypeFilter] = useState(null);

  const tiles = useMemo(() => merchandiserTiles(ds, rows, summary, scope), [ds, rows, summary, scope]);
  const block = useMemo(() => todayBlock(rows, 6), [rows]);
  const byType = useMemo(() => groupRowsByType(rows), [rows]);

  /* Critical first, then attention, then by how late — the order a person
     would work through them. The engine already ranks severity; this only
     applies that ranking to the list. */
  const actionRows = useMemo(() => {
    const scoped = typeFilter ? (byType.get(typeFilter) || []) : rows;
    return [...scoped]
      .filter(r => r.severity !== "normal")
      .sort((a, b) => a.severityRank - b.severityRank || (b.daysDelayed || 0) - (a.daysDelayed || 0));
  }, [rows, byType, typeFilter]);

  useEffect(() => { setPage(1); }, [typeFilter, pageSize, rows]);

  const pageCount = Math.max(1, Math.ceil(actionRows.length / pageSize));
  const current = Math.min(page, pageCount);
  const pageRows = actionRows.slice((current - 1) * pageSize, current * pageSize);

  const chips = useMemo(
    () => [...byType.entries()]
      .map(([type, list]) => ({ type, label: NOTIFICATION_TYPES[type].label, count: list.length, severity: list[0].severity }))
      .sort((a, b) => b.count - a.count),
    [byType]
  );

  return (
    <>
      <KpiStrip tiles={tiles} />

      <div className="db-split">
        <MyActions plan={plan} />
        <TodayBlock block={block} onTrack={onTrackPos(ds, rows, scope)} />
      </div>

      <div className="rc-card no-pad db-actionable">
        <SectionHead
          eyebrow="My critical actions"
          title={typeFilter ? NOTIFICATION_TYPES[typeFilter].label : "Everything needing action"}
          right={
            <div className="db-sec-tools">
              <span className="muted-sm">{actionRows.length.toLocaleString()} alert{actionRows.length === 1 ? "" : "s"}</span>
              <button className="btn-amber" onClick={() => onExport(actionRows, typeFilter ? NOTIFICATION_TYPES[typeFilter].label : "My critical actions")}>
                Export Excel
              </button>
            </div>
          }
        />

        <div className="db-chips">
          <button className={typeFilter === null ? "active" : ""} onClick={() => setTypeFilter(null)}>
            All <span className="c">{rows.filter(r => r.severity !== "normal").length}</span>
          </button>
          {chips.map(c => (
            <button key={c.type} className={typeFilter === c.type ? "active" : ""} onClick={() => setTypeFilter(c.type)}>
              {SEVERITY[c.severity].dot} {c.label} <span className="c">{c.count}</span>
            </button>
          ))}
        </div>

        <ActionTable rows={pageRows} dateFormat={dateFormat} />

        <div className="db-pager-wrap">
          <Pager total={actionRows.length} page={current} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} />
        </div>
        <p className="db-foot-note">
          Clicking a PO opens that order on the exact milestone raising the alert — no searching for it in the Orders list.
        </p>
      </div>

      <QuickActions items={[
        ...(modules.orders ? [["/orders?mine=1", "My Orders", "Everything assigned to me"]] : []),
        ...(modules.workbench ? [["/workbench", "Daily Workbench", "Update plan and actual dates"]] : []),
        ["/ai-assistant", "AI Assistant", "The full operational list"],
        ...(modules.reports ? [["/reports", "Reports Center", "Corporate analysis and exports"]] : []),
      ]} />
    </>
  );
}
