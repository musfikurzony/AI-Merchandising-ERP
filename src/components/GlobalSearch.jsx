import React, { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { globalSearch, MIN_QUERY } from "../lib/globalSearch.js";
import { fmtCompact } from "../lib/dateFormat.js";

/* The top-bar search, made real.

   Keyboard first, because the people using this all day have both hands on
   the keyboard already: Ctrl/Cmd+K focuses it from anywhere, arrows move
   through the results, Enter opens the highlighted one, Escape closes.

   Typing is debounced and every in-flight request is aborted when the next
   keystroke arrives, so holding a key down does not queue eight queries whose
   answers then race each other into the list. */

const DEBOUNCE_MS = 220;

export default function GlobalSearch({ dateFormat }) {
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [active, setActive] = useState(0);
  const boxRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const navigate = useNavigate();

  /* Ctrl/Cmd+K from anywhere, and Escape to let go again. */
  useEffect(() => {
    function onKey(e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    function onClick(e) { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    if (term.trim().length < MIN_QUERY) {
      abortRef.current?.abort();
      setRows([]); setBusy(false); setError(null);
      return;
    }
    setBusy(true);
    const handle = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await globalSearch(term, { signal: ctrl.signal });
        /* A late answer to an old question must not overwrite the answer to
           the current one. */
        if (ctrl.signal.aborted) return;
        setRows(res.rows); setActive(0); setError(null); setOpen(true);
      } catch (e) {
        if (!ctrl.signal.aborted) { setError(e.message); setRows([]); }
      } finally {
        if (!ctrl.signal.aborted) setBusy(false);
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [term]);

  function go(row) {
    if (!row) return;
    setOpen(false);
    setTerm("");
    setRows([]);
    inputRef.current?.blur();
    navigate(`/orders/${row.id}`);
  }

  function onKeyDown(e) {
    if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); return; }
    if (!open || rows.length === 0) {
      if (e.key === "Enter" && term.trim().length >= MIN_QUERY) setOpen(true);
      return;
    }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive(a => (a + 1) % rows.length); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(a => (a - 1 + rows.length) % rows.length); }
    else if (e.key === "Enter") { e.preventDefault(); go(rows[active]); }
  }

  const showPanel = open && term.trim().length >= MIN_QUERY;

  return (
    <div className="gs" ref={boxRef}>
      <span className="gs-icon" aria-hidden="true">⌕</span>
      <input
        ref={inputRef}
        className="gs-input"
        value={term}
        placeholder="Search PO, style or customer…"
        aria-label="Search orders by PO, style or customer"
        autoComplete="off"
        onChange={e => { setTerm(e.target.value); setOpen(true); }}
        onFocus={() => { if (term.trim().length >= MIN_QUERY) setOpen(true); }}
        onKeyDown={onKeyDown}
      />
      {term ? (
        <button className="gs-clear" title="Clear" onClick={() => { setTerm(""); setRows([]); inputRef.current?.focus(); }}>×</button>
      ) : (
        <span className="gs-hint" aria-hidden="true">Ctrl K</span>
      )}

      {showPanel && (
        <div className="gs-panel" role="listbox">
          {busy && rows.length === 0 && <div className="gs-note">Searching…</div>}
          {error && <div className="gs-note gs-error">{error}</div>}
          {!busy && !error && rows.length === 0 && (
            <div className="gs-note">No order matches “{term.trim()}”. Try a PO number, a style or a customer.</div>
          )}
          {rows.map((r, i) => (
            <button
              key={r.id}
              role="option"
              aria-selected={i === active}
              className={"gs-row" + (i === active ? " active" : "")}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(r)}
            >
              <span className="gs-po">{r.po}</span>
              <span className="gs-style">{r.style}</span>
              <span className="gs-meta">{[r.customer, r.factory].filter(Boolean).join(" · ") || "—"}</span>
              <span className="gs-etd">
                {r.etd ? fmtCompact(r.etd, dateFormat) : "—"}
                {r.revised && <span className="gs-rev" title="Revised ETD">rev</span>}
              </span>
            </button>
          ))}
          {rows.length > 0 && (
            <div className="gs-foot">↑ ↓ to move · Enter to open · Esc to close</div>
          )}
        </div>
      )}
    </div>
  );
}
