import React from "react";
import { Link } from "react-router-dom";
import { SEVERITY } from "../../lib/notificationsApi.js";
import { fmtCompact } from "../../lib/dateFormat.js";
import { Pager, PAGE_SIZES } from "../../components/Pager.jsx";

/* Shared Dashboard furniture. Presentation only — nothing here decides
   what a number means, it only decides how a number looks and where
   clicking it goes. */

/* Re-exported so the dashboard bodies keep importing their furniture from
   one place, while the pager itself lives in components/ and is shared with
   the Workbench. */
export { Pager, PAGE_SIZES };

export function fmtNum(n) {
  return n == null || n === "" ? "—" : Number(n).toLocaleString("en-US");
}

export function fmtTile(value, format) {
  if (value == null) return "—";
  if (format === "money") return "$" + Math.round(value).toLocaleString("en-US");
  if (format === "pct") return `${value}%`;
  if (format === "qty") return Number(value).toLocaleString("en-US");
  return Number(value).toLocaleString("en-US");
}

/* A KPI that cannot be clicked is a dead end: the manager reads "26 at
   risk" and then has to go and find those 26 by hand. Every tile that has
   a meaningful destination is a link, and looks like one. */
/* The column count divides the tile count exactly, so the strip is always a
   full rectangle. Twelve tiles on a six-column grid is 6+6; ten on the same
   grid is 6+4, and the ragged second row reads as a mistake rather than a
   layout. Each dashboard has a different number of tiles, so the count is
   computed rather than fixed. */
function columnsFor(n) {
  for (const c of [6, 5, 4, 3]) if (n % c === 0) return c;
  return 4;
}

export function KpiStrip({ tiles }) {
  return (
    <div className="db-kpis" style={{ "--db-cols": columnsFor(tiles.length) }}>
      {tiles.map(t => {
        const body = (
          <>
            <div className="l">{t.label}</div>
            <div className="v">{fmtTile(t.value, t.format)}</div>
            <div className="s">{t.sub}</div>
          </>
        );
        const cls = "db-kpi" + (t.tone ? ` tone-${t.tone}` : "") + (t.to ? " clickable" : "");
        return t.to
          ? <Link key={t.key} to={t.to} className={cls}>{body}</Link>
          : <div key={t.key} className={cls}>{body}</div>;
      })}
    </div>
  );
}

/* "Start here" in miniature. The wording and the ordering are the AI
   Assistant's — this is the same list, shortened. */
export function MyActions({ plan, title = "My Actions Today", emptyText }) {
  return (
    <div className="db-actions">
      <div className="db-actions-head">
        <span className="db-eyebrow">Start here</span>
        <h3>{plan.length ? `${plan.length} thing${plan.length === 1 ? "" : "s"} need you today` : "Nothing needs chasing right now"}</h3>
        <Link to="/ai-assistant" className="db-viewall">Open AI Assistant →</Link>
      </div>
      {plan.length === 0 ? (
        <p className="db-empty">{emptyText || "No overdue milestones, missed ETDs or unassigned factories in this selection."}</p>
      ) : (
        <ol className="db-action-list">
          {plan.map(p => (
            <li key={p.type} className={`sev-${p.severity}`}>
              <span className="n">{p.n}</span>
              <span className="t">{SEVERITY[p.severity].dot} <strong>{p.poCount} PO{p.poCount === 1 ? "" : "s"}</strong> — {p.label}</span>
              <span className="q">{fmtNum(p.qty)} pcs</span>
              <Link className="go" to={`/ai-assistant?type=${p.type}`}>View →</Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* The compact Critical / Attention / On Track block. Deliberately a list,
   not twenty cards: the Dashboard says what and how many, the AI Assistant
   says which. */
export function TodayBlock({ block, onTrack, exportType }) {
  const row = (item) => (
    <li key={item.type}>
      <Link className="lbl" to={item.to}>{item.label}</Link>
      <span className="cnt">{item.poCount} PO{item.poCount === 1 ? "" : "s"}</span>
      <span className="qty">{fmtNum(item.qty)} pcs</span>
      {exportType && <button className="btn-link xs" onClick={() => exportType(item.type)}>Excel</button>}
    </li>
  );
  const section = (key, label, items, hidden) => items.length > 0 && (
    <div className={`db-today-sec sev-${key}`}>
      <div className="db-today-head">
        <span className="ttl">{SEVERITY[key].dot} {label}</span>
        <span className="sub">{items.reduce((a, i) => a + i.count, 0)} alerts</span>
      </div>
      <ul>{items.map(row)}</ul>
      {hidden > 0 && <Link className="db-more" to="/ai-assistant">+{hidden} more categor{hidden === 1 ? "y" : "ies"} in the AI Assistant →</Link>}
    </div>
  );

  return (
    <div className="db-today">
      {section("critical", "Critical — needs immediate action", block.critical, block.hiddenCritical)}
      {section("attention", "Attention required", block.attention, block.hiddenAttention)}
      {section("warning", "Upcoming risk", block.warning, 0)}
      <div className="db-today-sec sev-normal">
        <div className="db-today-head">
          <span className="ttl">{SEVERITY.normal.dot} On track</span>
          <span className="sub">nothing outstanding</span>
        </div>
        <p className="db-ontrack"><strong>{fmtNum(onTrack)}</strong> PO in this period raised no alert at all.</p>
      </div>
    </div>
  );
}

/* The actionable table. One component, three dashboards — the columns the
   user asked for, in the order they read them, with the PO as a direct
   link to the milestone that fixes the problem. */
export const ACTION_COLUMNS = [
  ["po", "PO"], ["style", "Style"], ["factory", "Factory"], ["label", "Label"],
  ["productGroup", "Product Group"], ["orderQty", "Qty"], ["etd", "ETD"],
  ["milestone", "Current milestone"], ["plannedDate", "Due date"], ["daysDelayed", "Days overdue"],
];

export function ActionTable({ rows, dateFormat, columns = ACTION_COLUMNS }) {
  return (
    <div className="rc-scroll">
      <table className="rc-table db-action-table">
        <thead>
          <tr>
            <th>Severity</th><th>Type</th>
            {columns.map(([, h]) => <th key={h} className={h === "Qty" || h === "Days overdue" ? "num" : ""}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td><span className={"rc-badge " + SEVERITY[r.severity].badge}>{SEVERITY[r.severity].dot} {SEVERITY[r.severity].label}</span></td>
              <td>{r.typeLabel}</td>
              {columns.map(([k]) => {
                if (k === "po") return <td key={k}><Link to={r.link} className="ai-po">{r.po}</Link></td>;
                if (k === "orderQty") return <td key={k} className="num">{fmtNum(r.orderQty)}</td>;
                if (k === "daysDelayed") return <td key={k} className="num">{r.daysDelayed != null ? `+${r.daysDelayed}` : "—"}</td>;
                if (k === "etd" || k === "plannedDate") return <td key={k} className="mono">{fmtCompact(r[k], dateFormat)}</td>;
                if (k === "style") return <td key={k} className="mono">{r.style}</td>;
                return <td key={k}>{r[k] || "—"}</td>;
              })}
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={columns.length + 2} className="empty-row">Nothing outstanding in this selection.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

export function QuickActions({ items }) {
  return (
    <div className="db-quick">
      {items.map(([to, label, note]) => (
        <Link key={to} to={to} className="db-quick-item">
          <span className="t">{label}</span>
          <span className="s">{note}</span>
        </Link>
      ))}
    </div>
  );
}

export function SectionHead({ eyebrow, title, right }) {
  return (
    <div className="db-sec-head">
      <div>
        <div className="db-eyebrow">{eyebrow}</div>
        <h3>{title}</h3>
      </div>
      {right}
    </div>
  );
}
