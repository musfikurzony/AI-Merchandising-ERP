import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { getMilestoneTypes, listWorkbenchOrders, listColorWays, listMilestones, saveMilestoneEdits, getColumnPrefs, saveColumnPrefs } from "../../lib/workbenchApi.js";
import { fmtCompact } from "../../lib/dateFormat.js";

/* Faithful port of Prototype v13's Daily Workbench -- same grid structure,
   same interactions (frozen columns with synced top/bottom scroll,
   Plan/Actual/Status triples, multi-select, right-click copy/paste an
   entire row's T&A with a fabric-reference mismatch warning, per-cell
   "apply to all colors," column visibility settings, dirty-tracking
   batch save), now reading and writing real Supabase data instead of
   demo state. Milestone catalog comes from the database
   (tna_milestone_types) rather than a hardcoded JS constant, but every
   rendering/interaction pattern is the same. */

const STATUS_OPTIONS = [["done", "Done"], ["onTrack", "On Track"], ["atRisk", "Overdue"], ["critical", "Delayed"], ["pending", "Pending"]];

function WbStatusSelect({ value, onChange, disabled }) {
  return (
    <select className="wb-status" value={value || "pending"} disabled={disabled} onChange={e => onChange(e.target.value)}>
      {STATUS_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
    </select>
  );
}

function fmtFob(n) { return n == null ? "—" : `$${Number(n).toFixed(2)}`; }
function fmtNum(n) { return n == null ? "—" : Number(n).toLocaleString("en-US"); }

function buildColorRows(orders, colorWaysByOrder) {
  const rows = [];
  orders.forEach(o => {
    const colors = colorWaysByOrder[o.id]?.length ? colorWaysByOrder[o.id] : [{ name: "—", qty: o.qty }];
    colors.forEach((cw, idx) => {
      rows.push({ rowId: `${o.id}-c${idx}`, order: o, colorName: cw.name, colorQty: cw.qty ?? o.qty, colorIdx: idx, spanCount: colors.length });
    });
  });
  return rows;
}

/* Very light, alternating tints so adjacent milestone groups are visually
   distinct without looking busy -- combined with row parity so zebra
   striping still reads correctly (an inline style always beats a CSS
   class, so both effects are computed together here rather than fighting
   over which one wins). */
const GROUP_TINTS = [
  ["#FFFFFF", "#FAFBFC"], // group 0: white / light grey (odd/even row)
  ["#F6FAF9", "#F0F6F5"], // group 1: pale teal
  ["#FAFAFC", "#F4F4F8"], // group 2: pale lavender
  ["#FCFAF6", "#F8F3EC"], // group 3: pale amber
];
function tintFor(colIndex, rowIndex) {
  const [odd, even] = GROUP_TINTS[colIndex % GROUP_TINTS.length];
  return rowIndex % 2 === 0 ? odd : even;
}

function fieldsFor(col, milestone, edits) {
  const edit = edits || {};
  if (col.field_type === "pds") {
    return {
      plan: ("plan_date" in edit ? edit.plan_date : milestone?.plan_date) || "",
      actual: ("actual_date" in edit ? edit.actual_date : milestone?.actual_date) || "",
      status: "status" in edit ? edit.status : milestone?.status || "pending",
    };
  }
  if (col.field_type === "text") return { value: "text_value" in edit ? edit.text_value : milestone?.text_value || "" };
  if (col.field_type === "single") return { value: "single_value" in edit ? edit.single_value : milestone?.single_value || "" };
  return { value: "status" in edit ? edit.status : milestone?.status || "pending" };
}

function MilestoneCells({ row, col, milestone, edit, setField, onApplyAll, tint }) {
  const disabled = col.style_level && row.colorIdx > 0;
  const f = fieldsFor(col, milestone, edit);
  const showApply = !col.style_level && row.spanCount > 1 && !disabled;
  const tintStyle = tint ? { background: tint } : undefined;

  if (col.field_type === "pds") {
    return (
      <React.Fragment>
        <td style={tintStyle}><input className="wb-input" type="date" disabled={disabled} value={f.plan} onChange={e => setField(row, col, "plan_date", e.target.value)} /></td>
        <td style={tintStyle}><input className="wb-input" type="date" disabled={disabled} value={f.actual} onChange={e => setField(row, col, "actual_date", e.target.value)} /></td>
        <td className="wb-cell-with-action" style={tintStyle}>
          <WbStatusSelect value={f.status} disabled={disabled} onChange={v => setField(row, col, "status", v)} />
          {showApply && <button className="wb-apply-btn" title="Apply to all colors of this style" onClick={() => onApplyAll(row, col)}>⇉</button>}
        </td>
      </React.Fragment>
    );
  }
  if (col.field_type === "text") {
    return <td className="wb-cell-with-action" style={tintStyle}><input className="wb-input wb-input-wide" value={f.value} onChange={e => setField(row, col, "text_value", e.target.value)} />{showApply && <button className="wb-apply-btn" onClick={() => onApplyAll(row, col)}>⇉</button>}</td>;
  }
  if (col.field_type === "single") {
    return <td className="wb-cell-with-action" style={tintStyle}><input className="wb-input" value={f.value} onChange={e => setField(row, col, "single_value", e.target.value)} />{showApply && <button className="wb-apply-btn" onClick={() => onApplyAll(row, col)}>⇉</button>}</td>;
  }
  return <td className="wb-cell-with-action" style={tintStyle}><WbStatusSelect value={f.value} onChange={v => setField(row, col, "status", v)} />{showApply && <button className="wb-apply-btn" onClick={() => onApplyAll(row, col)}>⇉</button>}</td>;
}

function ColumnSettingsButton({ milestoneTypes, colPrefs, setColPrefs, onPersist }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  async function done() {
    setSaving(true);
    try { await onPersist(colPrefs); } catch (e) { /* non-fatal -- selection still applies this session even if the save failed */ }
    setSaving(false);
    setOpen(false);
  }
  return (
    <div style={{ position: "relative", marginLeft: "auto" }}>
      <button className="btn-ghost-sm" onClick={() => setOpen(!open)}>Choose Milestones</button>
      {open && (
        <div className="col-settings-panel">
          <div className="col-settings-title">Choose milestones to show</div>
          <p className="muted-sm" style={{ marginTop: -4, marginBottom: 8 }}>Remembered for your account — everyone can have their own set.</p>
          {milestoneTypes.map(col => (
            <label key={col.key} className="col-settings-row">
              <input type="checkbox" checked={!!colPrefs[col.key]} onChange={e => setColPrefs({ ...colPrefs, [col.key]: e.target.checked })} />
              {col.label}
            </label>
          ))}
          <button className="btn-primary" style={{ marginTop: 10, width: "100%" }} onClick={done} disabled={saving}>{saving ? "Saving..." : "Done"}</button>
        </div>
      )}
    </div>
  );
}

export default function Workbench() {
  const { dateFormat } = useOutletContext();
  const [milestoneTypes, setMilestoneTypes] = useState([]);
  const [orders, setOrders] = useState([]);
  const [colorWaysByOrder, setColorWaysByOrder] = useState({});
  const [milestonesByKey, setMilestonesByKey] = useState({}); // `${orderId}|${milestoneKey}` -> row
  const [colPrefs, setColPrefs] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [f, setF] = useState({ lifecycle: "open", q: "", factory: "all", productGroup: "all", merchandiser: "all", risk: "all", etdFrom: "", etdTo: "" });
  const [edits, setEdits] = useState({}); // rowId -> milestoneKey -> { field: value }
  const [selected, setSelected] = useState(() => new Set());
  const [clipboard, setClipboard] = useState(null);
  const [ctxMenu, setCtxMenu] = useState(null);
  const [pasteWarning, setPasteWarning] = useState(null);
  const [activeRowId, setActiveRowId] = useState(null);
  const scrollRef = useRef(null);
  const topScrollRef = useRef(null);
  const [scrollWidth, setScrollWidth] = useState(0);

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const [types, ords] = await Promise.all([getMilestoneTypes(), listWorkbenchOrders()]);
      setMilestoneTypes(types);
      const savedPrefs = await getColumnPrefs();
      const defaults = Object.fromEntries(types.map(t => [t.key, t.default_on]));
      setColPrefs(prev => Object.keys(prev).length ? prev : { ...defaults, ...(savedPrefs || {}) });
      setOrders(ords);
      const orderIds = ords.map(o => o.id);
      const [cws, ms] = await Promise.all([listColorWays(orderIds), listMilestones(orderIds)]);
      const cwMap = {};
      cws.forEach(cw => { (cwMap[cw.order_id] = cwMap[cw.order_id] || []).push(cw); });
      setColorWaysByOrder(cwMap);
      const msMap = {};
      ms.forEach(m => { msMap[`${m.order_id}|${m.milestone_key}|${m.color_way_name || ""}`] = m; });
      setMilestonesByKey(msMap);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }
  useEffect(() => { refresh(); }, []);

  const productGroups = useMemo(() => [...new Set(orders.map(o => o.product_groups?.name).filter(Boolean))], [orders]);
  const merchandisers = useMemo(() => [...new Set(orders.map(o => o.profiles?.full_name).filter(Boolean))], [orders]);

  const filteredOrders = orders.filter(o =>
    (f.lifecycle === "all" || (f.lifecycle === "shipped" ? o.status === "shipped" : o.status !== "shipped")) &&
    (f.productGroup === "all" || o.product_groups?.name === f.productGroup) &&
    (f.merchandiser === "all" || o.profiles?.full_name === f.merchandiser) &&
    (f.risk === "all" || o.risk === f.risk) &&
    (!f.q || `${o.po_prefix}${o.po_number} ${o.style} ${o.customers?.name || ""}`.toLowerCase().includes(f.q.toLowerCase())) &&
    (!f.etdFrom || !o.etd || o.etd >= f.etdFrom) &&
    (!f.etdTo || !o.etd || o.etd <= f.etdTo)
  );

  const rows = useMemo(() => buildColorRows(filteredOrders, colorWaysByOrder), [filteredOrders, colorWaysByOrder]);
  const cols = milestoneTypes.filter(c => colPrefs[c.key]);

  useEffect(() => { if (scrollRef.current) setScrollWidth(scrollRef.current.scrollWidth); }, [rows, cols.length]);

  function ck(col, row) { return col.color_level ? `${col.key}::${row.colorName}` : col.key; }

  function setField(row, col, field, value) {
    // Postgres date columns reject "" outright (confirmed: this was the
    // exact "invalid input syntax for type date" error reported) -- an
    // empty date input means "cleared," which is null, not empty string.
    // Only applies to the two date fields; text/status fields legitimately
    // use "" to mean "cleared" and stay as-is.
    const normalized = (field === "plan_date" || field === "actual_date") && value === "" ? null : value;
    const key = ck(col, row);
    setEdits(prev => ({ ...prev, [row.rowId]: { ...prev[row.rowId], [key]: { ...(prev[row.rowId]?.[key]), [field]: normalized } } }));
  }
  const changedCount = Object.values(edits).reduce((n, ms) => n + Object.keys(ms).length, 0);

  async function save() {
    setSaving(true); setError(null);
    try {
      // Translate rowId-keyed edits (per color-row) into orderId-keyed edits
      // for the API -- milestones live on the order, not the color row,
      // except style-level ones are already only editable on the first row.
      const byOrder = {};
      for (const [rowId, milestones] of Object.entries(edits)) {
        const row = rows.find(r => r.rowId === rowId);
        if (!row) continue;
        byOrder[row.order.id] = { ...(byOrder[row.order.id] || {}), ...milestones };
      }
      await saveMilestoneEdits(byOrder);
      setEdits({}); setSelected(new Set());
      await refresh();
    } catch (e) {
      setError(e.message);
    }
    setSaving(false);
  }
  function discard() { setEdits({}); }
  function syncFromTop(e) { if (scrollRef.current) scrollRef.current.scrollLeft = e.target.scrollLeft; }
  function syncFromBottom(e) { if (topScrollRef.current) topScrollRef.current.scrollLeft = e.target.scrollLeft; }

  function toggleRow(rowId) { setSelected(prev => { const next = new Set(prev); next.has(rowId) ? next.delete(rowId) : next.add(rowId); return next; }); }
  function toggleAll() { setSelected(prev => prev.size === rows.length ? new Set() : new Set(rows.map(r => r.rowId))); }

  function applyToAllColors(row, col) {
    const key = ck(col, row);
    setEdits(prev => {
      const next = { ...prev };
      const current = next[row.rowId]?.[key] || fieldsFromMilestone(row, col);
      const siblings = rows.filter(r => r.order.id === row.order.id && r.rowId !== row.rowId);
      siblings.forEach(s => { next[s.rowId] = { ...next[s.rowId], [ck(col, s)]: current }; });
      return next;
    });
  }
  function fieldsFromMilestone(row, col) {
    const m = milestonesByKey[`${row.order.id}|${col.key}|${col.color_level ? row.colorName : ""}`];
    if (!m) return {};
    return { plan_date: m.plan_date, actual_date: m.actual_date, status: m.status, text_value: m.text_value, single_value: m.single_value };
  }

  function getRowSnapshot(row) {
    const snap = {};
    milestoneTypes.forEach(col => { const key = ck(col, row); snap[key] = edits[row.rowId]?.[key] || fieldsFromMilestone(row, col); });
    return snap;
  }
  function copyRow(rowId) {
    const row = rows.find(r => r.rowId === rowId);
    if (!row) return;
    const snapshot = getRowSnapshot(row);
    const fabRef = snapshot.fab_ref?.text_value ?? milestonesByKey[`${row.order.id}|fab_ref|`]?.text_value ?? "";
    setClipboard({ sourceRowId: rowId, sourcePo: `${row.order.po_prefix}${row.order.po_number}`, sourceColor: row.colorName, fabRef, snapshot });
    setCtxMenu(null);
  }
  function pasteTargetsFor(rowId) { return selected.size > 0 ? Array.from(selected) : [rowId]; }
  function doPaste(targetRowIds) {
    targetRowIds.forEach(id => {
      if (id === clipboard.sourceRowId) return;
      const targetRow = rows.find(r => r.rowId === id);
      // Snapshot keys were built from the SOURCE row's color name for
      // color-level milestones -- remap them to the TARGET row's own
      // color name so a paste across different colors still lands each
      // color-level value on the correct color, not the source color's key.
      const remapped = {};
      milestoneTypes.forEach(col => {
        const srcKey = ck(col, { colorName: clipboard.sourceColor });
        const destKey = ck(col, targetRow);
        if (clipboard.snapshot[srcKey] !== undefined) remapped[destKey] = clipboard.snapshot[srcKey];
      });
      setEdits(prev => ({ ...prev, [id]: { ...prev[id], ...remapped } }));
    });
    setPasteWarning(null);
  }
  function requestPaste(targetRowIds) {
    if (!clipboard) return;
    const mismatches = [];
    targetRowIds.forEach(id => {
      if (id === clipboard.sourceRowId) return;
      const row = rows.find(r => r.rowId === id);
      if (!row) return;
      const destFabRef = edits[id]?.fab_ref?.text_value ?? milestonesByKey[`${row.order.id}|fab_ref|`]?.text_value ?? "";
      if (destFabRef !== clipboard.fabRef) mismatches.push({ rowId: id, po: `${row.order.po_prefix}${row.order.po_number}`, color: row.colorName, fabRef: destFabRef });
    });
    if (mismatches.length > 0) setPasteWarning({ targets: targetRowIds, mismatches });
    else doPaste(targetRowIds);
    setCtxMenu(null);
  }

  useEffect(() => {
    function onKey(e) {
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && activeRowId) { e.preventDefault(); copyRow(activeRowId); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v" && clipboard) {
        const targets = selected.size > 0 ? Array.from(selected) : (activeRowId ? [activeRowId] : []);
        if (targets.length) { e.preventDefault(); requestPaste(targets); }
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const openCount = orders.filter(o => o.status !== "shipped").length;
  const criticalCount = orders.filter(o => o.risk === "critical").length;
  const followupCount = orders.filter(o => o.risk === "atRisk" || o.risk === "critical").length;

  if (loading) return <div style={{ padding: 32 }}>Loading...</div>;

  return (
    <div style={{ padding: 24 }}>
      <div className="wb-summary-bar">
        <div><span className="wb-summary-num">{openCount}</span> Open Orders</div>
        <div className="sev-bad"><span className="wb-summary-num">{criticalCount}</span> Critical</div>
        <div className="sev-warn"><span className="wb-summary-num">{followupCount}</span> Today's Follow-ups</div>
        {clipboard && <div className="wb-clip-indicator">📋 Copied: {clipboard.sourcePo} / {clipboard.sourceColor} <button className="wb-clip-clear" onClick={() => setClipboard(null)}>×</button></div>}
      </div>

      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}

      <div className="filter-row wb-filters">
        <input className="table-search" placeholder="Search PO, style, customer…" value={f.q} onChange={e => setF({ ...f, q: e.target.value })} />
        <button className={"filter-chip" + (f.lifecycle === "open" ? " active" : "")} onClick={() => setF({ ...f, lifecycle: "open" })}>Open Orders</button>
        <button className={"filter-chip" + (f.lifecycle === "shipped" ? " active" : "")} onClick={() => setF({ ...f, lifecycle: "shipped" })}>Shipped Orders</button>
        <button className={"filter-chip" + (f.lifecycle === "all" ? " active" : "")} onClick={() => setF({ ...f, lifecycle: "all" })}>All Orders</button>
        <select value={f.productGroup} onChange={e => setF({ ...f, productGroup: e.target.value })}><option value="all">All Product Groups</option>{productGroups.map(x => <option key={x} value={x}>{x}</option>)}</select>
        <select value={f.merchandiser} onChange={e => setF({ ...f, merchandiser: e.target.value })}><option value="all">All Merchandisers</option>{merchandisers.map(x => <option key={x} value={x}>{x}</option>)}</select>
        <select value={f.risk} onChange={e => setF({ ...f, risk: e.target.value })}><option value="all">All Risk</option><option value="onTrack">On Track</option><option value="atRisk">At Risk</option><option value="critical">Critical</option><option value="aging">Aging</option></select>
        <input type="date" value={f.etdFrom} onChange={e => setF({ ...f, etdFrom: e.target.value })} title="ETD from" />
        <input type="date" value={f.etdTo} onChange={e => setF({ ...f, etdTo: e.target.value })} title="ETD to" />
        <ColumnSettingsButton milestoneTypes={milestoneTypes} colPrefs={colPrefs} setColPrefs={setColPrefs} onPersist={saveColumnPrefs} />
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar">
          <span>{selected.size} row{selected.size > 1 ? "s" : ""} selected</span>
          {clipboard && <button className="btn-primary" onClick={() => requestPaste(Array.from(selected))}>Paste Entire T&amp;A to selected</button>}
          <button className="btn-ghost-sm" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}

      <div ref={topScrollRef} onScroll={syncFromTop} className="wb-top-scroll"><div style={{ width: scrollWidth, height: 1 }} /></div>

      <div className="card no-pad">
        <div className="tna-scroll" ref={scrollRef} onScroll={syncFromBottom}>
          <table className="data-table wb-table">
            <thead>
              <tr>
                <th rowSpan={2} className="wb-frozen wb-frozen-0"><input type="checkbox" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleAll} /></th>
                <th rowSpan={2} className="wb-frozen wb-frozen-1">PO</th>
                <th rowSpan={2} className="wb-frozen wb-frozen-2">Style</th>
                <th rowSpan={2} className="wb-frozen wb-frozen-3">Color</th>
                <th rowSpan={2} className="wb-frozen wb-frozen-4">Qty</th>
                <th rowSpan={2} className="wb-frozen wb-frozen-5">FOB</th>
                <th rowSpan={2} className="wb-frozen wb-frozen-6">ETD</th>
                <th rowSpan={2} className="wb-frozen wb-frozen-7">Rev ETD</th>
                <th rowSpan={2} className="wb-frozen wb-frozen-8"></th>
                {cols.map(col => col.field_type === "pds"
                  ? <th key={col.key} colSpan={3} style={{ textAlign: "center" }}>{col.label}{col.style_level ? " (style-level)" : ""}</th>
                  : <th key={col.key} rowSpan={2}>{col.label}</th>)}
              </tr>
              <tr>
                {cols.filter(c => c.field_type === "pds").map(col => (
                  <React.Fragment key={col.key}><th>Plan</th><th>Actual</th><th>Status</th></React.Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={row.rowId} className={selected.has(row.rowId) ? "wb-row-selected" : ""}
                  onClick={() => setActiveRowId(row.rowId)}
                  onContextMenu={e => { e.preventDefault(); setActiveRowId(row.rowId); setCtxMenu({ x: e.clientX, y: e.clientY, rowId: row.rowId }); }}>
                  <td className="wb-frozen wb-frozen-0"><input type="checkbox" checked={selected.has(row.rowId)} onChange={() => toggleRow(row.rowId)} /></td>
                  <td className="wb-frozen wb-frozen-1 mono strong">{row.order.po_prefix}{row.order.po_number}</td>
                  <td className="wb-frozen wb-frozen-2 mono">{row.order.style}</td>
                  <td className="wb-frozen wb-frozen-3 mono">{row.colorName}</td>
                  <td className="wb-frozen wb-frozen-4 mono">{fmtNum(row.colorQty)}</td>
                  <td className="wb-frozen wb-frozen-5 mono">{"fob" in row.order ? fmtFob(row.order.fob) : "—"}</td>
                  <td className="wb-frozen wb-frozen-6 mono">{fmtCompact(row.order.etd, dateFormat)}</td>
                  <td className="wb-frozen wb-frozen-7 mono">{fmtCompact(row.order.revised_etd, dateFormat)}</td>
                  <td className="wb-frozen wb-frozen-8">
                    <Link to={`/orders/${row.order.id}`} className="wb-icon-btn" title="Open order">↗</Link>
                    <button className="wb-icon-btn" title="Copy Entire T&amp;A" onClick={() => copyRow(row.rowId)}>⧉</button>
                  </td>
                  {cols.map((col, colIndex) => (
                    <MilestoneCells key={col.key} row={row} col={col}
                      milestone={milestonesByKey[`${row.order.id}|${col.key}|${col.color_level ? row.colorName : ""}`]}
                      edit={edits[row.rowId]?.[ck(col, row)]} setField={setField} onApplyAll={applyToAllColors}
                      tint={tintFor(colIndex, rowIndex)} />
                  ))}
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={9 + cols.reduce((n, c) => n + (c.field_type === "pds" ? 3 : 1), 0)} className="empty-row">No orders match this filter.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {changedCount > 0 && (
        <div className="save-bar">
          <span>{changedCount} unsaved change{changedCount > 1 ? "s" : ""}</span>
          <div><button className="btn-ghost-sm" onClick={discard} disabled={saving}>Discard</button><button className="btn-primary" style={{ marginLeft: 10 }} onClick={save} disabled={saving}>{saving ? "Saving..." : "Save"}</button></div>
        </div>
      )}
      <p className="muted-sm" style={{ marginTop: 12 }}>Right-click a row (or use the ⧉ icon) for Copy/Paste Entire T&amp;A, or select rows first to paste into all of them at once. Ctrl/Cmd+C copies the last row you clicked; Ctrl/Cmd+V pastes to your selection. A Fabric Reference mismatch always asks before pasting. Hover a milestone cell on a multi-color style for "Apply to all colors" (⇉).</p>

      {ctxMenu && (
        <React.Fragment>
          <div className="ctx-overlay" onClick={() => setCtxMenu(null)} onContextMenu={e => { e.preventDefault(); setCtxMenu(null); }} />
          <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
            <button onClick={() => copyRow(ctxMenu.rowId)}>Copy Entire T&amp;A</button>
            <button disabled={!clipboard} onClick={() => requestPaste(pasteTargetsFor(ctxMenu.rowId))}>Paste Entire T&amp;A{selected.size > 1 ? ` (${selected.size} rows)` : ""}</button>
          </div>
        </React.Fragment>
      )}

      {pasteWarning && (
        <div className="modal-overlay">
          <div className="modal-box">
            <div className="modal-title">Different Fabric Reference</div>
            <p className="muted-sm">The selected rows have a different Fabric Reference than the copied row. Copying T&amp;A may be incorrect because milestones are usually fabric dependent.</p>
            <div className="modal-compare">
              <div><div className="ws-k">Source</div><div className="ws-v mono">{clipboard.fabRef || "—"}</div></div>
              <div>
                <div className="ws-k">Destination</div>
                {pasteWarning.mismatches.slice(0, 4).map(m => <div key={m.rowId} className="mono ws-v" style={{ fontSize: 12 }}>{m.po} / {m.color}: {m.fabRef || "—"}</div>)}
                {pasteWarning.mismatches.length > 4 && <div className="muted-sm">+{pasteWarning.mismatches.length - 4} more</div>}
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
              <button className="btn-ghost-sm" onClick={() => setPasteWarning(null)}>Cancel</button>
              <button className="btn-primary wb-paste-anyway" onClick={() => doPaste(pasteWarning.targets)}>Paste Anyway</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
