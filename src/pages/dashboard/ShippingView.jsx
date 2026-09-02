import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { shippingTiles, todayBlock, onTrackPos, groupRowsByType, shipmentQuantities } from "../../lib/dashboardApi.js";
import { NOTIFICATION_TYPES, SEVERITY } from "../../lib/notificationsApi.js";
import { orderMetrics } from "../../lib/reportsApi.js";
import { fmtCompact } from "../../lib/dateFormat.js";
import { KpiStrip, MyActions, TodayBlock, Pager, QuickActions, SectionHead, fmtNum } from "./parts.jsx";

/* ==========================================================================
   The shipping user's landing page.
   ==========================================================================
   A completely different question from the merchandiser's: not "which of
   my orders are late" but "what leaves, what is stuck, and what is wrong".
   So the columns are shipping's columns — quantity ordered against
   quantity shipped, the balance, the shipping status and one action — and
   the destination is the Shipping Portal rather than the T&A grid.

   The shipping rules themselves (short shipment, split delivery, missing
   documentation, ready to invoice, ETD passed) come from the same engine
   as everything else. The old Dashboard defined its own — "Ex-Factory 7+
   days with no shipment lines" — and that second rule set is exactly what
   this replaces. */

const SHIPPING_TYPES = ["etd_passed", "shipping_window", "short_shipment", "split_delivery", "shipment_docs", "ready_to_invoice"];

export default function ShippingView({ ds, rows, summary, plan, dateFormat, modules, scope, onExport }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [typeFilter, setTypeFilter] = useState(null);

  const tiles = useMemo(() => shippingTiles(ds, rows, scope), [ds, rows, scope]);
  const block = useMemo(() => todayBlock(rows, 6), [rows]);
  const byType = useMemo(() => groupRowsByType(rows), [rows]);
  const q = useMemo(() => shipmentQuantities(ds), [ds]);

  const actionRows = useMemo(() => {
    const scoped = typeFilter ? (byType.get(typeFilter) || []) : rows;
    return [...scoped]
      .filter(r => r.severity !== "normal")
      .sort((a, b) => a.severityRank - b.severityRank || String(a.etd || "").localeCompare(String(b.etd || "")));
  }, [rows, byType, typeFilter]);

  useEffect(() => { setPage(1); }, [typeFilter, pageSize, rows]);

  const pageCount = Math.max(1, Math.ceil(actionRows.length / pageSize));
  const current = Math.min(page, pageCount);
  const pageRows = actionRows.slice((current - 1) * pageSize, current * pageSize);

  const chips = useMemo(
    () => SHIPPING_TYPES
      .filter(t => byType.has(t))
      .map(t => ({ type: t, label: NOTIFICATION_TYPES[t].label, count: byType.get(t).length, severity: byType.get(t)[0].severity })),
    [byType]
  );

  return (
    <>
      <KpiStrip tiles={tiles} />

      <div className="db-split">
        <MyActions plan={plan} emptyText="Nothing waiting on shipping right now — no passed ETDs, short shipments or documentation gaps." />
        <TodayBlock block={block} onTrack={onTrackPos(ds, rows, scope)} />
      </div>

      <div className="rc-card no-pad db-actionable">
        <SectionHead
          eyebrow="Shipping action list"
          title={typeFilter ? NOTIFICATION_TYPES[typeFilter].label : "Everything needing shipping action"}
          right={
            <div className="db-sec-tools">
              <span className="muted-sm">{actionRows.length.toLocaleString()} alert{actionRows.length === 1 ? "" : "s"}</span>
              <button className="btn-amber" onClick={() => onExport(actionRows, typeFilter ? NOTIFICATION_TYPES[typeFilter].label : "Shipping action list")}>
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

        <div className="rc-scroll">
          <table className="rc-table db-action-table">
            <thead>
              <tr>
                {/* Type is shown because one PO legitimately appears more than
                    once — past its ETD *and* short-shipped are two different
                    things to do about the same order, and a list that repeated
                    the PO without saying why would look like a duplicate row. */}
                <th>Severity</th><th>Type</th><th>PO</th><th>Style</th><th>Factory</th><th>Label</th>
                <th className="num">Ordered</th><th className="num">Shipped</th><th className="num">Balance</th>
                <th>ETD</th><th>Shipping status</th><th>Action</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map(r => (
                <tr key={r.id}>
                  <td><span className={"rc-badge " + SEVERITY[r.severity].badge}>{SEVERITY[r.severity].dot} {SEVERITY[r.severity].label}</span></td>
                  <td>{r.typeLabel}</td>
                  <td><Link to={r.link} className="ai-po">{r.po}</Link></td>
                  <td className="mono">{r.style}</td>
                  <td>{r.factory}</td>
                  <td>{r.label || "—"}</td>
                  <td className="num">{fmtNum(r.orderQty)}</td>
                  <td className="num">{fmtNum(r.shippedQty)}</td>
                  <td className="num">{fmtNum(r.balanceQty)}</td>
                  <td className="mono">{fmtCompact(r.revisedEtd || r.etd, dateFormat)}</td>
                  <td>{r.currentStatus}</td>
                  <td>
                    {modules.shipping
                      ? <Link className="btn-link" to="/shipping">Open →</Link>
                      : <Link className="btn-link" to={r.link}>Open →</Link>}
                  </td>
                </tr>
              ))}
              {pageRows.length === 0 && <tr><td colSpan={12} className="empty-row">Nothing outstanding in this selection.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="db-pager-wrap">
          <Pager total={actionRows.length} page={current} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} />
        </div>
      </div>

      <div className="rc-card db-shipqty">
        <SectionHead eyebrow="Movement" title="Shipped quantity" />
        <div className="db-qty-row">
          <div><span className="l">Today</span><span className="v">{fmtNum(q.today)}</span><span className="s">{q.todayLines} line{q.todayLines === 1 ? "" : "s"}</span></div>
          <div><span className="l">This week</span><span className="v">{fmtNum(q.week)}</span><span className="s">from {q.weekFrom}</span></div>
          <div><span className="l">Month to date</span><span className="v">{fmtNum(q.mtd)}</span><span className="s">from {q.monthFrom}</span></div>
          <div><span className="l">Still to ship</span><span className="v">{fmtNum(ds.orders.reduce((s, o) => s + Math.max(0, orderMetrics(o, ds.shipmentSummaryByOrder).balanceQty), 0))}</span><span className="s">open balance</span></div>
        </div>
        <p className="db-foot-note">
          Counted from the shipment lines themselves, by the date the goods actually left — not from order status, which
          would credit an order to today merely for still being open.
        </p>
      </div>

      <QuickActions items={[
        ...(modules.shipping ? [["/shipping", "Shipping Portal", "Enter and lock shipments"]] : []),
        ...(modules.shipping ? [["/shipping-reports", "Shipping Reports", "Invoice and destination analysis"]] : []),
        ["/ai-assistant", "AI Assistant", "The full operational list"],
        ...(modules.reports ? [["/reports", "Reports Center", "Corporate analysis and exports"]] : []),
      ]} />
    </>
  );
}
