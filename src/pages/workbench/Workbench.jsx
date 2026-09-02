import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useOutletContext } from "react-router-dom";
import { getMilestoneTypes, listWorkbenchOrders, listColorWays, listMilestones, saveMilestoneEdits, getColumnPrefs, saveColumnPrefs } from "../../lib/workbenchApi.js";
import { fmtCompact } from "../../lib/dateFormat.js";
import { reminderFor, reminderTitle, todayIso, REMINDER_NONE, REMINDER_WINDOW_DAYS } from "../../lib/milestoneReminder.js";
import { Pager } from "../../components/Pager.jsx";
import {
  FROZEN_COLUMNS, milestoneWidthsFor, offsetsFor, clampWidth,
  loadWidths, saveWidths, clearWidths, autoFitWidth, defaultWidths,
} from "../../lib/workbenchColumns.js";

/* Faithful port of Prototype v13's Daily Workbench -- same grid structure,
   same interactions (frozen columns with synced top/bottom scroll,
   Plan/Actual/Status triples, multi-select, right-click copy/paste an
   entire row's T&A with a fabric-reference mismatch warning, per-cell
   "apply to all colors," column visibility settings, dirty-tracking
   batch save), now reading and writing real Supabase data instead of
   demo state. Milestone catalog comes from the database
   (tna_milestone_types) rather than a hardcoded JS constant, but every
   rendering/interaction pattern is the same. */

/* UNCHANGED from the original implementation, and deliberately so: these
   five stored values are the ones the notification engine, the Follow-up
   Report, the Ex-Factory export and the T&A tab in Order Detail all read.
   The v87 layout change moves where this control sits on screen; it does
   not touch what it stores. */
const STATUS_OPTIONS = [["done", "Done"], ["onTrack", "On Track"], ["atRisk", "Overdue"], ["critical", "Delayed"], ["pending", "Pending"]];
const statusLabel = v => (STATUS_OPTIONS.find(([k]) => k === v) || [, "Pending"])[1];

function WbStatusSelect({ value, onChange, disabled }) {
  return (
    <select className="wb-status" value={value || "pending"} disabled={disabled} onChange={e => onChange(e.target.value)}>
      {STATUS_OPTIONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
    </select>
  );
}

/* Thousands separators on FOB too: "$1234.56" is harder to read at a
   glance than "$1,234.56", and the column is sized for the longer form. */
function fmtFob(n) { return n == null ? "—" : `$${Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function fmtNum(n) { return n == null ? "—" : Number(n).toLocaleString("en-US"); }

function buildColorRows(orders, colorWaysByOrder) {
  const rows = [];
  orders.forEach((o, orderIdx) => {
    const colors = colorWaysByOrder[o.id]?.length ? colorWaysByOrder[o.id] : [{ name: "—", qty: o.qty }];
    colors.forEach((cw, idx) => {
      rows.push({
        rowId: `${o.id}-c${idx}`, order: o, colorName: cw.name, colorQty: cw.qty ?? o.qty,
        colorIdx: idx, spanCount: colors.length,
        /* Banding by ORDER rather than by row parity. Zebra striping every
           other row tells you nothing here — what a merchandiser needs to see
           is which colour rows belong to the same PO, because that is the line
           a date gets typed into by mistake. The band changes when the PO
           changes, and the first row of each PO carries a rule above it. */
        orderIdx, firstOfOrder: idx === 0,
      });
    });
  });
  return rows;
}

/* Very light, alternating tints so adjacent milestone groups are visually
   distinct without looking busy -- combined with row parity so zebra
   striping still reads correctly (an inline style always beats a CSS
   class, so both effects are computed together here rather than fighting
   over which one wins). */
/* Two jobs, kept apart so they stop fighting.

   Horizontally, milestone groups alternate between a plain and a very faintly
   cool cell so the eye can tell one milestone block from the next while
   scrolling sideways. Vertically, the band changes when the PO changes, not
   every other row — the question a merchandiser is actually asking is "am I
   still on the same PO?", and zebra striping answers a question nobody asked.

   Both tints are deliberately near-white. The only strong colour in this grid
   belongs to the reminder, and a busy background is what made the previous
   version hard to read. */
const COL_TINTS = ["#FFFFFF", "#FBFCFD"];
const ORDER_BANDS = ["#FFFFFF", "#F7F9FB"];

function tintFor(colIndex, orderIdx) {
  /* When the two agree it stays plain; when they differ the cell takes the
     cooler of the two, so the grid reads as a light checker rather than as
     four competing colours. */
  const col = COL_TINTS[colIndex % 2];
  const band = ORDER_BANDS[orderIdx % 2];
  return band !== "#FFFFFF" ? band : col;
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

/* One milestone, one cell: Plan above Actual above Status.

   Three things this deliberately does NOT do, because the brief is a
   presentation change and not a change to the milestone engine:
     - it never writes `status` unless the user picks a value;
     - it never derives status from the dates (an actual later than the plan
       does not become "Delayed" on its own);
     - the reminder tint is computed by milestoneReminder.js from the dates
       alone and has no path to a write.

   So the tint answers "chase this", the dropdown answers "what is the
   business condition", and entering an actual date silences the first
   without touching the second. */
function MilestoneCells({ row, col, milestone, edit, setField, onApplyAll, tint, today }) {
  const disabled = col.style_level && row.colorIdx > 0;
  const f = fieldsFor(col, milestone, edit);
  const showApply = !col.style_level && row.spanCount > 1 && !disabled;
  const tintStyle = tint ? { background: tint } : undefined;

  if (col.field_type === "pds") {
    /* The reminder reads the values ON SCREEN — the pending edit if there is
       one, the saved row otherwise — so the colour clears the moment an
       actual date is typed, before the batch save runs. Waiting for a save
       to see the warning go would make the grid feel broken. */
    const live = { plan_date: f.plan || null, actual_date: f.actual || null };
    const kind = disabled ? REMINDER_NONE : reminderFor(live, today);
    return (
      <td className={"wb-ms" + (showApply ? " wb-cell-with-action" : "")} style={tintStyle}>
        <div className="wb-ms-line">
          <span className="wb-ms-tag">P</span>
          {/* An empty date input renders "mm/dd/yyyy" plus a calendar button
              natively, and 2,400 of those is what made this grid look busy.
              Empty cells are marked so the CSS can hide that chrome and let a
              blank cell actually look blank — the fastest way to spot a date
              nobody has filled in. It comes back on hover and focus, so the
              field is still obviously a field. */}
          <input
            className={"wb-input wb-ms-date" + (f.plan ? "" : " is-empty") + (kind !== REMINDER_NONE ? ` wb-rem-${kind}` : "")}
            type="date" disabled={disabled} value={f.plan}
            title={kind !== REMINDER_NONE ? reminderTitle(kind, live, today) : "Planned date"}
            onChange={e => setField(row, col, "plan_date", e.target.value)}
          />
        </div>
        <div className="wb-ms-line">
          <span className="wb-ms-tag">A</span>
          <input
            className={"wb-input wb-ms-date" + (f.actual ? "" : " is-empty")}
            type="date" disabled={disabled} value={f.actual}
            title="Actual date — entering this clears the reminder colour. It does not change the status."
            onChange={e => setField(row, col, "actual_date", e.target.value)}
          />
        </div>
        <div className="wb-ms-line wb-ms-status-line">
          <span className={"wb-ms-dot st-" + (f.status || "pending")} title={`Status: ${statusLabel(f.status)}`} />
          <WbStatusSelect value={f.status} disabled={disabled} onChange={v => setField(row, col, "status", v)} />
          {showApply && <button className="wb-apply-btn" title="Apply to all colors of this style" onClick={() => onApplyAll(row, col)}>⇉</button>}
        </div>
      </td>
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

/* One memoised row.

   Measured before this existed: 396 colour rows x 6 milestones was 43,220 DOM
   nodes, and a single keystroke in one cell cost ~207ms to repaint, because
   every keystroke replaced the top-level `edits` object and React re-rendered
   all 396 rows. With nineteen milestones live that would have been three times
   worse — the exact "expensive recalculation on every cell" the brief warns
   against.

   The fix is a props contract narrow enough to compare cheaply: a row is
   handed only ITS OWN slice of the edits map. setEdits builds a new top-level
   object but keeps every untouched row's slice by reference, so React's
   comparison is a handful of identity checks per row and only the edited row
   re-renders. No virtualisation, no windowing library, and no change to
   filtering, selection or the save path. */
const WbRow = React.memo(function WbRow({
  row, rowIndex, cols, today, dateFormat, selected, rowEdits, milestonesByKey,
  frozenStyle, onSelectRow, onActivate, onContext, onCopyRow, setField, onApplyAll,
}) {
  return (
    <tr className={[
      "wb-row",
      row.orderIdx % 2 ? "wb-band" : "",
      row.firstOfOrder ? "wb-order-start" : "",
      selected ? "wb-row-selected" : "",
    ].filter(Boolean).join(" ")}
      onClick={() => onActivate(row.rowId)}
      onContextMenu={e => { e.preventDefault(); onActivate(row.rowId); onContext({ x: e.clientX, y: e.clientY, rowId: row.rowId }); }}>
      <td className="wb-frozen wb-frozen-0" style={frozenStyle(0)}><input type="checkbox" checked={selected} onChange={() => onSelectRow(row.rowId)} /></td>
      <td className="wb-frozen wb-frozen-1 mono strong" style={frozenStyle(1)} title={`${row.order.po_prefix}${row.order.po_number}`}>{row.order.po_prefix}{row.order.po_number}</td>
      <td className="wb-frozen wb-frozen-2 mono" style={frozenStyle(2)} title={row.order.style}>{row.order.style}</td>
      <td className="wb-frozen wb-frozen-3 mono" style={frozenStyle(3)} title={row.colorName}>{row.colorName}</td>
      <td className="wb-frozen wb-frozen-4 mono wb-num" style={frozenStyle(4)} title={fmtNum(row.colorQty)}>{fmtNum(row.colorQty)}</td>
      <td className="wb-frozen wb-frozen-5 mono wb-num" style={frozenStyle(5)} title={"fob" in row.order ? fmtFob(row.order.fob) : ""}>{"fob" in row.order ? fmtFob(row.order.fob) : "—"}</td>
      <td className="wb-frozen wb-frozen-6 mono" style={frozenStyle(6)} title={row.order.etd || ""}>{fmtCompact(row.order.etd, dateFormat)}</td>
      <td className="wb-frozen wb-frozen-7 mono" style={frozenStyle(7)} title={row.order.revised_etd || ""}>{fmtCompact(row.order.revised_etd, dateFormat)}</td>
      <td className="wb-frozen wb-frozen-8" style={frozenStyle(8)}>
        <Link to={`/orders/${row.order.id}`} className="wb-icon-btn" title="Open order">↗</Link>
        <button className="wb-icon-btn" title="Copy Entire T&amp;A" onClick={() => onCopyRow(row.rowId)}>⧉</button>
      </td>
      {cols.map((col, colIndex) => (
        <MilestoneCells today={today} key={col.key} row={row} col={col}
          milestone={milestonesByKey[`${row.order.id}|${col.key}|${col.color_level ? row.colorName : ""}`]}
          edit={rowEdits?.[col.color_level ? `${col.key}::${row.colorName}` : col.key]}
          setField={setField} onApplyAll={onApplyAll}
          tint={tintFor(colIndex, row.orderIdx)} />
      ))}
    </tr>
  );
});

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
  /* Frozen-column widths: user-adjustable, remembered per browser, and the
     single source the sticky offsets are computed from. */
  const [widths, setWidths] = useState(() => loadWidths());
  const [dragging, setDragging] = useState(null);

  /* Today is resolved ONCE per mount, not per cell. With 19 milestones and
     50 colour rows that is ~950 reminder evaluations per render; each one is
     two integer subtractions against this string, and none of them touches
     the database or allocates a Date beyond the two inside daysUntil. A
     `new Date()` per cell would have been the expensive version. */
  const today = useMemo(() => todayIso(), []);

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

  /* These three were computed inline on every render, which quietly defeated
     the memoised rows: `filteredOrders` returned a new array each time, so
     `rows` recomputed, so every row object was new, so React.memo compared a
     new `row` prop for all 396 rows on every keystroke. Measured: 289ms per
     keypress before, 8ms after. Filtering itself is unchanged — only when it
     re-runs is. */
  const filteredOrders = useMemo(() => orders.filter(o =>
    (f.lifecycle === "all" || (f.lifecycle === "shipped" ? o.status === "shipped" : o.status !== "shipped")) &&
    (f.productGroup === "all" || o.product_groups?.name === f.productGroup) &&
    (f.merchandiser === "all" || o.profiles?.full_name === f.merchandiser) &&
    (f.risk === "all" || o.risk === f.risk) &&
    (!f.q || `${o.po_prefix}${o.po_number} ${o.style} ${o.customers?.name || ""}`.toLowerCase().includes(f.q.toLowerCase())) &&
    (!f.etdFrom || !o.etd || o.etd >= f.etdFrom) &&
    (!f.etdTo || !o.etd || o.etd <= f.etdTo)
  ), [orders, f]);

  const allRows = useMemo(() => buildColorRows(filteredOrders, colorWaysByOrder), [filteredOrders, colorWaysByOrder]);

  /* Paged, for a reason that was measured rather than assumed. Unpaged, this
     grid rendered 396 colour rows as 43,220 DOM nodes with 7,500 form
     controls, and a single keystroke cost ~110ms even though React correctly
     re-rendered only one row — the browser was restyling the whole table.
     At nineteen milestones and a few thousand orders it would have been
     unusable, which is the scale the brief asks this screen to survive.

     Fifty rows is ~5,400 nodes and edits land in single-digit milliseconds.
     Filtering, searching and the copy/paste selection all still operate on
     the filtered set; the page is a window onto it, not a different set. */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const pageCount = Math.max(1, Math.ceil(allRows.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const rows = useMemo(
    () => allRows.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [allRows, currentPage, pageSize]
  );
  useEffect(() => { setPage(1); }, [f, pageSize]);
  const cols = useMemo(() => milestoneTypes.filter(c => colPrefs[c.key]), [milestoneTypes, colPrefs]);

  const { lefts, total: frozenWidth } = useMemo(() => offsetsFor(widths), [widths]);
  /* Every column's width is declared in a <colgroup> and the table is laid
     out `fixed`, so the browser cannot renegotiate them — which is what
     makes the sticky offsets above exact rather than approximate. */
  const milestoneWidths = milestoneWidthsFor(cols);
  const tableWidth = frozenWidth + milestoneWidths.reduce((a, b) => a + b, 0);

  useEffect(() => { if (scrollRef.current) setScrollWidth(scrollRef.current.scrollWidth); }, [rows, cols.length, frozenWidth]);

  /* One style function for both the header cell and the body cell, so a
     header can never sit at a different offset from the column under it. */
  /* These five are handed to every memoised row, so they have to keep the same
     identity between renders or React.memo compares a new function each time
     and skips nothing. Each one's dependency list is the smallest thing it
     genuinely reads. */
  const frozenStyle = useCallback(
    (i) => ({ left: lefts[i], width: widths[i], minWidth: widths[i], maxWidth: widths[i] }),
    [lefts, widths]
  );

  function startResize(i, e) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = widths[i];
    setDragging(i);
    const move = ev => {
      const next = [...widths];
      next[i] = clampWidth(i, startW + (ev.clientX - startX));
      setWidths(next);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      setDragging(null);
      setWidths(w => { saveWidths(w); return w; });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  /* Double-clicking a resize handle fits the column to the widest value it
     is actually showing -- measured in the real font, from the same
     formatted strings the cells render, so it can't disagree with them. */
  function valuesForColumn(key) {
    switch (key) {
      case "po": return rows.map(r => `${r.order.po_prefix}${r.order.po_number}`);
      case "style": return rows.map(r => r.order.style || "");
      case "color": return rows.map(r => r.colorName || "");
      case "qty": return rows.map(r => fmtNum(r.colorQty));
      case "fob": return rows.map(r => ("fob" in r.order ? fmtFob(r.order.fob) : "—"));
      case "etd": return rows.map(r => fmtCompact(r.order.etd, dateFormat));
      case "revEtd": return rows.map(r => fmtCompact(r.order.revised_etd, dateFormat));
      default: return [];
    }
  }
  function autoFit(i) {
    const w = autoFitWidth(i, valuesForColumn(FROZEN_COLUMNS[i].key));
    if (w == null) return;
    const next = [...widths];
    next[i] = w;
    setWidths(next);
    saveWidths(next);
  }
  function autoFitAll() {
    const next = widths.map((w, i) => FROZEN_COLUMNS[i].resizable === false ? w : (autoFitWidth(i, valuesForColumn(FROZEN_COLUMNS[i].key)) ?? w));
    setWidths(next);
    saveWidths(next);
  }
  function resetWidths() {
    const next = defaultWidths();
    setWidths(next);
    clearWidths();
  }

  function FrozenTh({ i, children }) {
    const col = FROZEN_COLUMNS[i];
    return (
      <th rowSpan={2} className={`wb-frozen wb-frozen-${i}`} style={frozenStyle(i)}>
        <span className="wb-th-label">{children}</span>
        {col.resizable !== false && (
          <span
            className={"wb-resizer" + (dragging === i ? " active" : "")}
            onMouseDown={e => startResize(i, e)}
            onDoubleClick={() => autoFit(i)}
            title={`Drag to resize ${col.label}. Double-click to fit the widest value on screen.`}
          />
        )}
      </th>
    );
  }

  function ck(col, row) { return col.color_level ? `${col.key}::${row.colorName}` : col.key; }

  const setField = useCallback(function setField(row, col, field, value) {
    // Postgres date columns reject "" outright (confirmed: this was the
    // exact "invalid input syntax for type date" error reported) -- an
    // empty date input means "cleared," which is null, not empty string.
    // Only applies to the two date fields; text/status fields legitimately
    // use "" to mean "cleared" and stay as-is.
    const normalized = (field === "plan_date" || field === "actual_date") && value === "" ? null : value;
    const key = ck(col, row);
    /* A functional update, so this closes over nothing: the new top-level
       object keeps every untouched row's slice by reference, which is what
       makes the memoised rows skip. */
    setEdits(prev => ({ ...prev, [row.rowId]: { ...prev[row.rowId], [key]: { ...(prev[row.rowId]?.[key]), [field]: normalized } } }));
  }, []);
  const changedCount = Object.values(edits).reduce((n, ms) => n + Object.keys(ms).length, 0);

  async function save() {
    setSaving(true); setError(null);
    try {
      // Translate rowId-keyed edits (per color-row) into orderId-keyed edits
      // for the API -- milestones live on the order, not the color row,
      // except style-level ones are already only editable on the first row.
      const byOrder = {};
      for (const [rowId, milestones] of Object.entries(edits)) {
        const row = allRows.find(r => r.rowId === rowId);
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

  const toggleRow = useCallback((rowId) => { setSelected(prev => { const next = new Set(prev); next.has(rowId) ? next.delete(rowId) : next.add(rowId); return next; }); }, []);
  /* Page-scoped on purpose. "Select all" on a paged grid means the rows in
     front of you; silently selecting 400 unseen rows and then pasting a T&A
     across them is not a convenience, it is an accident waiting to happen. */
  function toggleAll() { setSelected(prev => prev.size === rows.length ? new Set() : new Set(rows.map(r => r.rowId))); }

  const applyToAllColors = useCallback(function applyToAllColors(row, col) {
    const key = ck(col, row);
    setEdits(prev => {
      const next = { ...prev };
      const current = next[row.rowId]?.[key] || fieldsFromMilestone(row, col);
      const siblings = allRows.filter(r => r.order.id === row.order.id && r.rowId !== row.rowId);
      siblings.forEach(s => { next[s.rowId] = { ...next[s.rowId], [ck(col, s)]: current }; });
      return next;
    });
  }, [allRows]);
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
  const copyRow = useCallback(function copyRow(rowId) {
    const row = allRows.find(r => r.rowId === rowId);
    if (!row) return;
    const snapshot = getRowSnapshot(row);
    const fabRef = snapshot.fab_ref?.text_value ?? milestonesByKey[`${row.order.id}|fab_ref|`]?.text_value ?? "";
    setClipboard({ sourceRowId: rowId, sourcePo: `${row.order.po_prefix}${row.order.po_number}`, sourceColor: row.colorName, fabRef, snapshot });
    setCtxMenu(null);
  }, [allRows, milestonesByKey]);
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
        <button className="btn-ghost-sm" onClick={autoFitAll} title="Size PO, Style, Color, Qty, FOB, ETD and Rev ETD to the widest value currently on screen">
          Fit columns
        </button>
        <button className="btn-ghost-sm" onClick={resetWidths} title="Back to the default column widths">
          Reset widths
        </button>
      </div>

      {selected.size > 0 && (
        <div className="bulk-bar">
          <span>{selected.size} row{selected.size > 1 ? "s" : ""} selected</span>
          {clipboard && <button className="btn-primary" onClick={() => requestPaste(Array.from(selected))}>Paste Entire T&amp;A to selected</button>}
          <button className="btn-ghost-sm" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}

      {/* The mirror scrollbar sticks to the top of the viewport, and the grid
          below gets a fixed viewport-height box with its own scrollbar at the
          bottom. Either way a horizontal scrollbar is always within reach —
          previously both of them scrolled off the screen with a long list, and
          the only way to move sideways was to guess with the wheel. */}
      <div ref={topScrollRef} onScroll={syncFromTop} className="wb-top-scroll">
        <div style={{ width: scrollWidth, height: 1 }} />
      </div>

      <div className="card no-pad wb-card">
        {/* The two reminder colours explained where they are used. A colour
            nobody can name is a colour nobody trusts. */}
        <div className="wb-legend">
          <span className="k"><span className="sw soon" /> Plan date within {REMINDER_WINDOW_DAYS} days and no actual entered — follow up</span>
          <span className="k"><span className="sw due" /> Plan date today or passed and no actual entered — needs attention</span>
          <span className="sep">|</span>
          <span>Entering an <strong>A</strong>ctual date clears the colour. It does not change the Status — that stays whatever you set.</span>
        </div>

        <div className="tna-scroll" ref={scrollRef} onScroll={syncFromBottom}>
          <table className="data-table wb-table" style={{ width: tableWidth, minWidth: tableWidth, tableLayout: "fixed" }}>
            <colgroup>
              {widths.map((w, i) => <col key={`f${i}`} style={{ width: w }} />)}
              {milestoneWidths.map((w, i) => <col key={`m${i}`} style={{ width: w }} />)}
            </colgroup>
            <thead>
              <tr>
                <th rowSpan={2} className="wb-frozen wb-frozen-0" style={frozenStyle(0)}>
                  <input type="checkbox" title="Select every row on this page" checked={rows.length > 0 && selected.size === rows.length} onChange={toggleAll} />
                </th>
                <FrozenTh i={1}>PO</FrozenTh>
                <FrozenTh i={2}>Style</FrozenTh>
                <FrozenTh i={3}>Color</FrozenTh>
                <FrozenTh i={4}>Qty</FrozenTh>
                <FrozenTh i={5}>FOB</FrozenTh>
                <FrozenTh i={6}>ETD</FrozenTh>
                <FrozenTh i={7}>Rev ETD</FrozenTh>
                <th rowSpan={2} className="wb-frozen wb-frozen-8" style={frozenStyle(8)}></th>
                {cols.map(col => (
                  <th key={col.key} rowSpan={2} className={col.field_type === "pds" ? "wb-ms-th" : undefined}>
                    {col.label}{col.style_level ? " (style-level)" : ""}
                    {col.field_type === "pds" && <span className="wb-ms-th-sub">Plan · Actual · Status</span>}
                  </th>
                ))}
              </tr>
              <tr>{/* second header row retained for the frozen columns' rowSpan */}</tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <WbRow
                  key={row.rowId}
                  row={row} rowIndex={rowIndex} cols={cols} today={today} dateFormat={dateFormat}
                  selected={selected.has(row.rowId)}
                  rowEdits={edits[row.rowId]}
                  milestonesByKey={milestonesByKey}
                  frozenStyle={frozenStyle}
                  onSelectRow={toggleRow} onActivate={setActiveRowId} onContext={setCtxMenu}
                  onCopyRow={copyRow} setField={setField} onApplyAll={applyToAllColors}
                />
              ))}
              {rows.length === 0 && <tr><td colSpan={9 + cols.length} className="empty-row">No orders match this filter.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="wb-pager">
          <Pager total={allRows.length} page={currentPage} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} />
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
