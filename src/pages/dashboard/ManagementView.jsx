import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ResponsiveContainer, ComposedChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, PieChart, Pie, Cell,
} from "recharts";
import {
  managementTiles, todayBlock, onTrackPos, overviewBy,
  otdTrend, deliveryBands, distributionBy, fiscalYearsIn,
} from "../../lib/dashboardApi.js";
import { SERIES_ACTUAL, getFiscalYear } from "../../lib/reportsApi.js";
import { loadGrowth, growthDeltas, GROWTH_METRICS, hasAnyData } from "../../lib/growthApi.js";
import { KpiStrip, MyActions, TodayBlock, QuickActions, SectionHead, fmtNum } from "./parts.jsx";

/* ==========================================================================
   The management landing page.
   ==========================================================================
   Five questions, in the order a senior manager asks them: how much
   business do we have, are we on track, what is going wrong, where is the
   problem, and who needs to act. The page is laid out in exactly that
   order, and the first screen answers the first three.

   Deliberately NOT a second Executive Dashboard. This is the concise
   landing page — three charts, not ten — and every performance section
   ends in a link into Reports Center or the Executive Dashboard where the
   deep analysis already lives. */

const fmtMoney = v => "$" + Math.round(v || 0).toLocaleString("en-US");

const DISTRIBUTIONS = [
  ["productGroup", "Product Group", o => o.product_group_code, o => o.product_groups?.name],
  ["label", "Label", o => o.label_code, o => o.labels?.name],
  ["factory", "Factory", o => o.factory_code, o => o.factories?.name],
  ["customer", "Customer", o => o.customer_code, o => o.customers?.name],
  ["merchandiser", "Merchandiser", o => o.primary_merchandiser_id, o => o.profiles?.full_name],
];

export default function ManagementView({ ds, rows, summary, plan, modules, scope, onExport, periodLabel }) {
  const [workloadDim, setWorkloadDim] = useState("factory");
  const [distKey, setDistKey] = useState("productGroup");
  const [growth, setGrowth] = useState(null);
  const [growthMetric, setGrowthMetric] = useState("poCount");

  const tiles = useMemo(() => managementTiles(ds, rows, summary, scope), [ds, rows, summary, scope]);
  const block = useMemo(() => todayBlock(rows, 5), [rows]);
  const loads = useMemo(() => overviewBy(rows, workloadDim), [rows, workloadDim]);
  const trend = useMemo(() => otdTrend(ds, { months: 6 }), [ds]);
  const bands = useMemo(() => deliveryBands(ds), [ds]);
  const dist = useMemo(() => {
    const d = DISTRIBUTIONS.find(x => x[0] === distKey) || DISTRIBUTIONS[0];
    return distributionBy(ds, d[2], d[3], 6);
  }, [ds, distKey]);

  const fyInData = useMemo(() => fiscalYearsIn(ds), [ds]);

  useEffect(() => {
    let live = true;
    loadGrowth({ endFy: getFiscalYear(new Date().toISOString().slice(0, 10)), back: 3 })
      .then(g => { if (live) setGrowth(g); })
      .catch(() => { if (live) setGrowth({ series: [], source: "none", partial: true, note: "Growth data could not be read." }); });
    return () => { live = false; };
  }, []);

  /* computeOnTimeBands already returns the four bands with their counts and
     the palette that was colour-vision validated for the On-Time report —
     reused rather than re-picked, so the two screens read as one system. */
  const bandData = useMemo(
    () => (bands?.bands || []).map(b => ({ key: b.key, name: b.label, value: b.poCount, fill: b.hex })).filter(d => d.value > 0),
    [bands]
  );

  const growthRows = useMemo(
    () => growth ? growthDeltas(growth.series, growthMetric) : [],
    [growth, growthMetric]
  );
  const growthMeta = GROWTH_METRICS.find(m => m[0] === growthMetric) || GROWTH_METRICS[0];
  const latestGrowth = growthRows.length ? growthRows[growthRows.length - 1] : null;

  return (
    <>
      <KpiStrip tiles={tiles} />

      <div className="db-split">
        <MyActions plan={plan} title="Start here" />
        <TodayBlock block={block} onTrack={onTrackPos(ds, rows, scope)} exportType={
          (type) => onExport(rows.filter(r => r.type === type), block.critical.concat(block.attention, block.warning).find(i => i.type === type)?.label || "Notifications")
        } />
      </div>

      {/* --- performance ------------------------------------------------ */}
      <div className="db-perf">
        <div className="rc-card">
          <SectionHead
            eyebrow="Performance"
            title="On-time delivery trend"
            right={modules.reports && <Link className="btn-link" to="/reports/on-time">View detailed report →</Link>}
          />
          {trend.length === 0 ? (
            <p className="db-empty">No shipped orders in this period to compare against their ETD.</p>
          ) : (
            <div style={{ height: 230 }}>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={trend} margin={{ top: 6, right: 8, bottom: 0, left: 4 }}>
                  <CartesianGrid stroke="#EFEBE3" vertical={false} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={{ stroke: "#E7E2D8" }} tickLine={false} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={false} tickLine={false} tickFormatter={v => `${v}%`} />
                  {/* One series, one axis. An earlier draft drew the same
                      percentage as both a bar and a line, which looks like two
                      measures and is really one. The bar carries the value;
                      how many POs it was computed from goes in the tooltip,
                      where it answers "is this month based on enough orders
                      to mean anything". */}
                  <Tooltip
                    formatter={(v, n, item) => [`${v}% on time — ${fmtNum(item?.payload?.onTime)} of ${fmtNum(item?.payload?.compared)} PO`, "On-time"]}
                    contentStyle={{ borderRadius: 8, border: "1px solid #E7E2D8", fontSize: 12 }} />
                  <Bar name="On-time %" dataKey="rate" fill={SERIES_ACTUAL} radius={[4, 4, 0, 0]} maxBarSize={34} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
          <p className="db-foot-note">
            Each month is the same on-time calculation the On-Time Performance report uses, applied to the orders whose
            ETD falls in that month. One scale, one unit.
          </p>
        </div>

        <div className="rc-card">
          <SectionHead
            eyebrow="Performance"
            title="Shipment performance"
            right={modules.reports && <Link className="btn-link" to="/reports/on-time">View detailed report →</Link>}
          />
          {bandData.length === 0 ? (
            <p className="db-empty">No comparable POs in this period.</p>
          ) : (
            <>
              <div style={{ height: 186 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={bandData} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="88%" paddingAngle={1} stroke="#fff" strokeWidth={2}>
                      {bandData.map(d => <Cell key={d.key} fill={d.fill} />)}
                    </Pie>
                    <Tooltip formatter={(v, n) => [`${v} PO${v === 1 ? "" : "s"}`, n]} contentStyle={{ borderRadius: 8, border: "1px solid #E7E2D8", fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <table className="rc-table db-mini">
                <tbody>
                  {bandData.map(d => (
                    <tr key={d.key}>
                      <td><span className="db-swatch" style={{ background: d.fill }} />{d.name}</td>
                      <td className="num">{fmtNum(d.value)}</td>
                      <td className="num">{bands.totals.poCount ? Math.round((d.value / bands.totals.poCount) * 100) : 0}%</td>
                    </tr>
                  ))}
                  <tr className="db-total">
                    <td>Total compared</td>
                    <td className="num">{fmtNum(bands.totals.poCount)}</td>
                    <td className="num">100%</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>

        <div className="rc-card">
          <SectionHead
            eyebrow="Order book"
            title="Distribution"
            right={modules.reports && <Link className="btn-link" to="/reports">View detailed report →</Link>}
          />
          <div className="db-chips tight">
            {DISTRIBUTIONS.map(([k, l]) => (
              <button key={k} className={distKey === k ? "active" : ""} onClick={() => setDistKey(k)}>{l}</button>
            ))}
          </div>
          <table className="rc-table db-mini">
            <thead><tr><th>{(DISTRIBUTIONS.find(d => d[0] === distKey) || [])[1]}</th><th className="num">PO</th><th className="num">Qty</th><th className="num">Value</th></tr></thead>
            <tbody>
              {dist.map(d => (
                <tr key={d.label}>
                  <td>{d.label}</td>
                  <td className="num">{fmtNum(d.poCount)}</td>
                  <td className="num">{fmtNum(d.qty)}</td>
                  <td className="num">{fmtMoney(d.value)}</td>
                </tr>
              ))}
              {dist.length === 0 && <tr><td colSpan={4} className="empty-row">Nothing in this period.</td></tr>}
            </tbody>
          </table>
          <p className="db-foot-note">Top six by quantity. Country is not shown because there is no country field in the ERP yet.</p>
        </div>
      </div>

      {/* --- company growth --------------------------------------------- */}
      <div className="rc-card db-growth">
        <SectionHead
          eyebrow="Company growth"
          title="How is the business growing, year over year?"
          right={
            <div className="db-sec-tools">
              <select value={growthMetric} onChange={e => setGrowthMetric(e.target.value)}>
                {GROWTH_METRICS.map(([k, l]) => (
                  <option key={k} value={k} disabled={growth?.partial && k !== "poCount"}>
                    {l}{growth?.partial && k !== "poCount" ? " — needs migration 37" : ""}
                  </option>
                ))}
              </select>
            </div>
          }
        />
        {!growth ? (
          <p className="db-empty">Reading fiscal-year totals…</p>
        ) : !hasAnyData(growth.series) ? (
          <p className="db-empty">
            No orders found in {growth.series.map(s => s.label).join(", ") || "any fiscal year"}. A growth comparison needs
            orders in more than one fiscal year — nothing is drawn here rather than showing an empty trend that would read
            as a collapse in business.
          </p>
        ) : (
          <>
            <div className="db-growth-cards">
              {growthRows.map(r => (
                <div key={r.fiscalYear} className="db-growth-card">
                  <div className="l">{r.label}</div>
                  <div className="v">{r.value == null ? "—" : growthMeta[2] === "money" ? fmtMoney(r.value) : fmtNum(r.value)}</div>
                  <div className={"d " + (r.pct == null ? "flat" : r.pct >= 0 ? "up" : "down")}>
                    {r.value == null ? "needs migration 37"
                      : r.prevValue == null ? "first year shown"
                      : r.pct == null ? "no orders in the prior year"
                      : `${r.pct >= 0 ? "+" : ""}${r.pct}% vs ${growthRows[growthRows.indexOf(r) - 1]?.label || "prior"}`}
                  </div>
                </div>
              ))}
            </div>
            {growthRows.some(r => r.value != null) && (
              <div style={{ height: 210 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={growthRows.filter(r => r.value != null)} margin={{ top: 6, right: 8, bottom: 0, left: 4 }}>
                    <CartesianGrid stroke="#EFEBE3" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={{ stroke: "#E7E2D8" }} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: "#6B7280" }} axisLine={false} tickLine={false}
                      tickFormatter={v => growthMeta[2] === "money" ? `$${(v / 1000).toFixed(0)}k` : v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v} />
                    <Tooltip
                      formatter={v => [growthMeta[2] === "money" ? fmtMoney(v) : fmtNum(v), growthMeta[1]]}
                      contentStyle={{ borderRadius: 8, border: "1px solid #E7E2D8", fontSize: 12 }} />
                    <Bar name={growthMeta[1]} dataKey="value" fill={SERIES_ACTUAL} radius={[4, 4, 0, 0]} maxBarSize={54} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        )}
        {growth?.partial && growth.note && <p className="db-warn-note">{growth.note}</p>}
        <p className="db-foot-note">
          Fiscal years run February to January and are labelled by the January they end in — FY{getFiscalYear("2026-02-01")} is
          Feb 2026 to Jan 2027. Totals are computed in the database, one row per year: no order rows are downloaded.
          {fyInData.length > 0 && ` The current period covers ${fyInData.map(f => "FY" + f).join(", ")}.`}
        </p>
      </div>

      {/* --- who has to act --------------------------------------------- */}
      <div className="rc-card no-pad">
        <SectionHead
          eyebrow="Where the problem is"
          title="Workload — who has to act"
          right={
            <div className="seg">
              <button className={workloadDim === "factory" ? "active" : ""} onClick={() => setWorkloadDim("factory")}>By factory</button>
              <button className={workloadDim === "merchandiser" ? "active" : ""} onClick={() => setWorkloadDim("merchandiser")}>By merchandiser</button>
            </div>
          }
        />
        <div className="rc-scroll">
          <table className="rc-table">
            <thead>
              <tr>
                <th>{workloadDim === "factory" ? "Factory" : "Merchandiser"}</th>
                <th className="num">POs</th><th className="num">🔴 Critical</th><th className="num">🟠 Attention</th>
                <th className="num">🟡 Warning</th><th className="num">Overdue</th><th className="num">Due ≤7d</th><th />
              </tr>
            </thead>
            <tbody>
              {loads.map(w => (
                <tr key={w.label}>
                  <td><strong>{w.label}</strong></td>
                  <td className="num">{fmtNum(w.poCount)}</td>
                  <td className="num">{w.critical || "—"}</td>
                  <td className="num">{w.attention || "—"}</td>
                  <td className="num">{w.warning || "—"}</td>
                  <td className="num">{w.overdue || "—"}</td>
                  <td className="num">{w.due7 || "—"}</td>
                  <td><Link className="btn-link" to={`/ai-assistant?${workloadDim}=${encodeURIComponent(w.label)}`}>Drill down →</Link></td>
                </tr>
              ))}
              {loads.length === 0 && <tr><td colSpan={8} className="empty-row">Nothing outstanding in this selection.</td></tr>}
            </tbody>
            {loads.length > 0 && (
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="num">{fmtNum(loads.reduce((s, w) => s + w.poCount, 0))}</td>
                  <td className="num">{fmtNum(summary.bySeverity.critical)}</td>
                  <td className="num">{fmtNum(summary.bySeverity.attention)}</td>
                  <td className="num">{fmtNum(summary.bySeverity.warning)}</td>
                  <td className="num">{fmtNum(loads.reduce((s, w) => s + w.overdue, 0))}</td>
                  <td className="num">{fmtNum(loads.reduce((s, w) => s + w.due7, 0))}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <QuickActions items={[
        ...(modules.orders ? [["/orders", "Orders", "The whole order book"]] : []),
        ...(modules.workbench ? [["/workbench", "Daily Workbench", "Update plan and actual dates"]] : []),
        ["/ai-assistant", "AI Assistant", "The full operational control tower"],
        ...(modules.reports ? [["/executive-dashboard", "Executive Dashboard", "Deep whole-business analysis"]] : []),
        ...(modules.reports ? [["/reports", "Reports Center", "Corporate reports, PDF and Excel"]] : []),
      ]} />
    </>
  );
}
