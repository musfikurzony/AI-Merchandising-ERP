import React, { useState } from "react";
import { GROUP_DIMENSIONS } from "../lib/reportsApi.js";
import {
  PERIOD_MODES, MONTH_NAMES, fiscalQuarters, DATE_BASIS_OPTIONS,
  fiscalYearChoices, resolvePeriod, countActiveFilters,
} from "../lib/reportContext.js";

/* ONE filter engine for every report.

   The requirement was "all reports must have grouping so we can filter
   from many angles". The mistake to avoid is giving each report its own
   filter row: they drift, one gains Label while another gains Division,
   and the same question asked on two screens returns two answers. So this
   is a single component, holding every dimension the orders table can
   actually be sliced by:

     WHO   — Factory, Merchandiser, Customer
     WHAT  — Product Group, Label, Division, Business Unit, Season, Style, PO
     WHEN  — Fiscal year / fiscal quarter / month / date range / all time,
             against a selectable date basis (ETD, Revised ETD, PO issue,
             Actual ETD, CRD)
     STATE — Order status

   Grouping is the same list of dimensions, used twice: a primary group and
   an optional second level, which is what turns a flat report into a real
   drill-down ("by Factory, then by Product Group") without a second report.

   Secondary filters are collapsed by default — the row stays readable, and
   the count on the "More filters" button means a hidden active filter can
   never be forgotten about. */

const METRICS = [
  ["orderedQty", "Ordered Qty"],
  ["shippedQty", "Shipped Qty"],
  ["balanceQty", "Balance Qty"],
  ["orderValue", "Order Value"],
  ["poCount", "PO Count"],
];

const STATUS_OPTIONS = ["unassigned", "sourcing", "production", "shipped", "cancelled"];

export default function ReportFilterBar({
  filters, onFilters,
  period, onPeriod,
  options = {}, seasons = [],
  showGrouping = true, groupBy, onGroupBy, groupBy2, onGroupBy2,
  metric, onMetric, topN, onTopN,
  onGenerate, loading, dirty, generateLabel = "Generate report",
}) {
  const [expanded, setExpanded] = useState(false);
  const set = (patch) => onFilters({ ...filters, ...patch });
  const setP = (patch) => onPeriod({ ...period, ...patch });
  const resolved = resolvePeriod(period);
  const activeCount = countActiveFilters(filters);

  return (
    <div className="rc-card rpt-filterbar">
      {/* --- WHEN ------------------------------------------------------- */}
      <div className="rpt-filter-row">
        <div className="rpt-field">
          <span className="field-label">Period</span>
          <div className="seg">
            {PERIOD_MODES.map(([k, l]) => (
              <button key={k} className={period.mode === k ? "active" : ""} onClick={() => setP({ mode: k })}>{l}</button>
            ))}
          </div>
        </div>

        {(period.mode === "fy" || period.mode === "quarter") && (
          <div className="rpt-field">
            <span className="field-label">Fiscal year (Feb–Jan)</span>
            <select value={period.fiscalYear} onChange={e => setP({ fiscalYear: e.target.value })}>
              {fiscalYearChoices().map(fy => <option key={fy} value={fy}>FY{fy}</option>)}
            </select>
          </div>
        )}
        {period.mode === "quarter" && (
          <div className="rpt-field">
            <span className="field-label">Quarter</span>
            <select value={period.quarter} onChange={e => setP({ quarter: e.target.value })}>
              {fiscalQuarters().map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
        )}
        {period.mode === "month" && (
          <>
            <div className="rpt-field">
              <span className="field-label">Month</span>
              <select value={period.month} onChange={e => setP({ month: e.target.value })}>
                {MONTH_NAMES.map((m, i) => <option key={m} value={i}>{m}</option>)}
              </select>
            </div>
            <div className="rpt-field">
              <span className="field-label">Year</span>
              <select value={period.monthYear} onChange={e => setP({ monthYear: e.target.value })}>
                {[...Array(6)].map((_, i) => {
                  const y = new Date().getFullYear() - 3 + i;
                  return <option key={y} value={y}>{y}</option>;
                })}
              </select>
            </div>
          </>
        )}
        {period.mode === "range" && (
          <>
            <div className="rpt-field">
              <span className="field-label">From</span>
              <input type="date" value={period.dateFrom} onChange={e => setP({ dateFrom: e.target.value })} />
            </div>
            <div className="rpt-field">
              <span className="field-label">To</span>
              <input type="date" value={period.dateTo} onChange={e => setP({ dateTo: e.target.value })} />
            </div>
          </>
        )}

        <div className="rpt-field">
          <span className="field-label">Date basis</span>
          <select value={filters.dateBasis} onChange={e => set({ dateBasis: e.target.value })}>
            {DATE_BASIS_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>

        <div className="rpt-field rpt-field-grow">
          <span className="field-label">Resolves to</span>
          <div className="rpt-resolved">
            {resolved.dateFrom || resolved.dateTo ? `${resolved.dateFrom || "…"} → ${resolved.dateTo || "…"}` : "no date limit"}
          </div>
        </div>

        <button className="btn-amber" onClick={onGenerate} disabled={loading}>
          {loading ? "Working…" : dirty ? `${generateLabel} ●` : generateLabel}
        </button>
      </div>

      {/* --- WHO / WHAT -------------------------------------------------- */}
      <div className="rpt-filter-row">
        <div className="rpt-field">
          <span className="field-label">Factory</span>
          <select value={filters.factoryCode} onChange={e => set({ factoryCode: e.target.value })}>
            <option value="">All factories</option>
            {(options.factories || []).map(f => <option key={f.code} value={f.code}>{f.name}</option>)}
          </select>
        </div>
        <div className="rpt-field">
          <span className="field-label">Merchandiser</span>
          <select value={filters.merchandiserId} onChange={e => set({ merchandiserId: e.target.value })}>
            <option value="">All merchandisers</option>
            {(options.merchandisers || []).map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
          </select>
        </div>
        <div className="rpt-field">
          <span className="field-label">Customer</span>
          <select value={filters.customerCode} onChange={e => set({ customerCode: e.target.value })}>
            <option value="">All customers</option>
            {(options.customers || []).map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </div>
        <div className="rpt-field">
          <span className="field-label">Product group</span>
          <select value={filters.productGroupCode} onChange={e => set({ productGroupCode: e.target.value })}>
            <option value="">All product groups</option>
            {(options.productGroups || []).map(p => <option key={p.code} value={p.code}>{p.name}</option>)}
          </select>
        </div>
        <div className="rpt-field">
          <span className="field-label">Label</span>
          <select value={filters.labelCode} onChange={e => set({ labelCode: e.target.value })}>
            <option value="">All labels</option>
            {(options.labels || []).map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
        </div>
        <button className="btn-outline" onClick={() => setExpanded(v => !v)}>
          {expanded ? "Fewer filters" : "More filters"}{activeCount > 0 ? ` · ${activeCount} active` : ""}
        </button>
        {activeCount > 0 && (
          <button className="btn-link" onClick={() => onFilters({
            dateBasis: filters.dateBasis, factoryCode: "", merchandiserId: "", customerCode: "",
            productGroupCode: "", labelCode: "", divisionCode: "", businessUnitCode: "",
            season: "", status: "", style: "", po: "",
          })}>Clear filters</button>
        )}
      </div>

      {expanded && (
        <div className="rpt-filter-row">
          <div className="rpt-field">
            <span className="field-label">Division</span>
            <select value={filters.divisionCode} onChange={e => set({ divisionCode: e.target.value })}>
              <option value="">All divisions</option>
              {(options.divisions || []).map(d => <option key={d.code} value={d.code}>{d.name}</option>)}
            </select>
          </div>
          <div className="rpt-field">
            <span className="field-label">Business unit</span>
            <select value={filters.businessUnitCode} onChange={e => set({ businessUnitCode: e.target.value })}>
              <option value="">All business units</option>
              {(options.businessUnits || []).map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
            </select>
          </div>
          <div className="rpt-field">
            <span className="field-label">Season</span>
            <select value={filters.season} onChange={e => set({ season: e.target.value })}>
              <option value="">All seasons</option>
              {seasons.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="rpt-field">
            <span className="field-label">Status</span>
            <select value={filters.status} onChange={e => set({ status: e.target.value })}>
              <option value="">All active statuses</option>
              {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="rpt-field">
            <span className="field-label">Style contains</span>
            <input placeholder="e.g. OCWR" value={filters.style} onChange={e => set({ style: e.target.value })} />
          </div>
          <div className="rpt-field">
            <span className="field-label">PO contains</span>
            <input placeholder="e.g. RT304" value={filters.po} onChange={e => set({ po: e.target.value })} />
          </div>
        </div>
      )}

      {/* --- HOW IT'S GROUPED -------------------------------------------- */}
      {showGrouping && (
        <div className="rpt-filter-row rpt-grouping">
          <div className="rpt-field">
            <span className="field-label">Group by</span>
            <select value={groupBy} onChange={e => onGroupBy(e.target.value)}>
              {GROUP_DIMENSIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div className="rpt-field">
            <span className="field-label">Then by (drill-down)</span>
            <select value={groupBy2} onChange={e => onGroupBy2(e.target.value)}>
              <option value="">— none —</option>
              {GROUP_DIMENSIONS.filter(([k]) => k !== groupBy).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div className="rpt-field">
            <span className="field-label">Rank by</span>
            <select value={metric} onChange={e => onMetric(e.target.value)}>
              {METRICS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
          <div className="rpt-field">
            <span className="field-label">Show</span>
            <select value={topN} onChange={e => onTopN(e.target.value)}>
              <option value="">All groups</option>
              <option value="10">Top 10</option>
              <option value="20">Top 20</option>
              <option value="50">Top 50</option>
            </select>
          </div>
          <span className="rpt-hint">
            Grouping and ranking apply instantly — only the period and filters above need <strong>{generateLabel}</strong>.
          </span>
        </div>
      )}
    </div>
  );
}
