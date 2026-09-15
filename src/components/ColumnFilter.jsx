import React, { useEffect, useMemo, useRef, useState } from "react";
import { optionsFor, BLANK_LABEL } from "../lib/sheetFilter.js";

/* The filter popover on a column header.

   Modelled directly on the PLM dialog the owner works in every day — a
   search box, a checkbox list of the values actually present, and a Clear
   that puts the column back. Two things were added because the ERP's
   sheets are longer than PLM's grids: each value shows how many rows it
   would keep, and "Select all" applies to what the SEARCH has narrowed to,
   not to the whole list, so filtering 400 styles down to "SWB" and hitting
   select-all does the obvious thing.

   The popover is positioned in the viewport with `position: fixed` and
   flipped left when it would run off the right edge. It deliberately does
   not live inside the table cell: a `th` in a scrolling, overflow-hidden
   container clips its own children, which is what made the first attempt
   render a popover with its bottom half missing. */

export default function ColumnFilter({ col, rows, filters, onChange, align = "left" }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const panelRef = useRef(null);

  const active = filters[col] && filters[col].size > 0;

  const { options, truncated, total } = useMemo(
    () => (open ? optionsFor(rows, filters, col) : { options: [], truncated: false, total: 0 }),
    [open, rows, filters, col]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return options;
    return options.filter(o => o.label.toLowerCase().includes(needle));
  }, [options, q]);

  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (panelRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    function onKey(e) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  function toggleOpen() {
    if (open) { setOpen(false); return; }
    const r = btnRef.current.getBoundingClientRect();
    const W = 268;
    /* Flip when it would overflow the right edge, and clamp so it can never
       be positioned off-screen on a narrow window. */
    const left = Math.max(8, Math.min(window.innerWidth - W - 8, align === "right" ? r.right - W : r.left));
    setPos({ left, top: r.bottom + 4, maxH: Math.max(180, window.innerHeight - r.bottom - 24) });
    setQ("");
    setOpen(true);
  }

  const selected = filters[col] || new Set();

  function setSelection(next) {
    const copy = { ...filters };
    if (!next || next.size === 0) delete copy[col];
    else copy[col] = next;
    onChange(copy);
  }

  function toggleValue(key) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    setSelection(next);
  }

  const visibleKeys = visible.map(o => o.key);
  const allVisibleOn = visibleKeys.length > 0 && visibleKeys.every(k => selected.has(k));

  return (
    <>
      <button
        ref={btnRef}
        className={"cf-btn" + (active ? " on" : "")}
        title={active ? `Filtered: ${[...selected].map(v => (v === " blank" ? BLANK_LABEL : v)).slice(0, 6).join(", ")}${selected.size > 6 ? "…" : ""}` : `Filter ${col}`}
        aria-label={`Filter ${col}`}
        onClick={e => { e.stopPropagation(); toggleOpen(); }}
      >▾</button>

      {open && pos && (
        <div ref={panelRef} className="cf-panel" style={{ left: pos.left, top: pos.top, maxHeight: pos.maxH }}>
          <div className="cf-head">
            <span className="cf-col">{col}</span>
            <span className="cf-count">{total.toLocaleString()} value{total === 1 ? "" : "s"}</span>
          </div>
          <input
            className="cf-search"
            autoFocus
            value={q}
            placeholder="Search values…"
            onChange={e => setQ(e.target.value)}
          />
          <label className="cf-all">
            <input
              type="checkbox"
              checked={allVisibleOn}
              onChange={() => {
                const next = new Set(selected);
                if (allVisibleOn) visibleKeys.forEach(k => next.delete(k));
                else visibleKeys.forEach(k => next.add(k));
                setSelection(next);
              }}
            />
            {q.trim() ? `Select all ${visible.length.toLocaleString()} matching` : "Select all"}
          </label>
          <div className="cf-list">
            {visible.length === 0 && <div className="cf-empty">No value matches “{q.trim()}”.</div>}
            {visible.map(o => (
              <label key={o.key} className="cf-item">
                <input type="checkbox" checked={selected.has(o.key)} onChange={() => toggleValue(o.key)} />
                <span className={"cf-label" + (o.key === " blank" ? " blank" : "")}>{o.label}</span>
                <span className="cf-n">{o.count.toLocaleString()}</span>
              </label>
            ))}
            {truncated && <div className="cf-empty">Showing the first 1,000 of {total.toLocaleString()} values — use the search box.</div>}
          </div>
          <div className="cf-foot">
            <button className="btn-link xs" onClick={() => setSelection(null)} disabled={!active}>Clear filter</button>
            <span className="spacer" />
            <button className="btn-outline xs" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </>
  );
}
