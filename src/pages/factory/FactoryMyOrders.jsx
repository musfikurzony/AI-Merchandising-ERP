import React, { useEffect, useMemo, useState } from "react";
import { listMyOrders, submitCrdUpdate, getCrdHistory } from "../../lib/factoryApi.js";
import { useSticky } from "../../lib/viewState.js";
import { groupByPo, availableColumns, get } from "../../lib/factoryPortal.js";

/* ==========================================================================
   My Orders — one row per PO, styles underneath.
   ==========================================================================
   "Factory will book based on PO. And one PO contains multiple styles,
   multiple colours." The list is now shaped like that sentence: the PO is
   the row, the styles are what you open it to see.

   Selection, CRD submission and history all operate on the PO. Underneath,
   the database still stores one row per style and the CRD engine still
   classifies each of them individually — the loop over style ids has not
   changed, only what the person is asked to point at. A factory should not
   have to select four rows to move one delivery date. */

function MixedTag({ children }) {
  return (
    <span title="The styles in this PO do not all carry the same value" style={{
      marginLeft: 6, fontSize: 10.5, padding: "1px 5px", borderRadius: 999,
      background: "#FEF3C7", color: "#92400E", whiteSpace: "nowrap",
    }}>{children}</span>
  );
}

function CrdModal({ groups, onClose, onSubmitted }) {
  const [newCrd, setNewCrd] = useState("");
  const [remarks, setRemarks] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const ids = groups.flatMap(g => g.ids);
  const lineCount = ids.length;

  async function handleSubmit() {
    if (!newCrd) { setError("New CRD date is required."); return; }
    setBusy(true); setError(null);
    try {
      const results = await submitCrdUpdate(ids, newCrd, remarks);
      const failures = results.filter(r => r.error);
      if (failures.length) setError(`${failures.length} of ${results.length} style lines failed: ${failures[0].error}`);
      else onSubmitted(groups.length);
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-box" style={{ width: 500 }}>
        <h3>Update CRD — {groups.length} PO{groups.length !== 1 ? "s" : ""}</h3>
        <div style={{ maxHeight: 130, overflowY: "auto", fontSize: 12, color: "#6B7280", marginBottom: 12 }}>
          {groups.map(g => (
            <div key={g.key}>
              <strong style={{ color: "#374151" }}>{g.po}</strong>
              {" — "}{g.lineCount} style line{g.lineCount !== 1 ? "s" : ""}
              {g.qty != null ? ` · ${g.qty.toLocaleString()} pcs` : ""}
            </div>
          ))}
        </div>
        <label className="field">New CRD
          <input type="date" value={newCrd} onChange={e => setNewCrd(e.target.value)} />
        </label>
        <label className="field">Remarks (applied to every line in the selected POs)
          <input value={remarks} onChange={e => setRemarks(e.target.value)} />
        </label>
        <p style={{ fontSize: 12, color: "#6B7280" }}>
          A CRD belongs to the PO, so this date is applied to all{" "}
          <strong>{lineCount}</strong> style line{lineCount !== 1 ? "s" : ""} under the
          {groups.length === 1 ? " PO" : " POs"} you selected. Each line still gets its
          own record, so its history and notifications stay accurate — this is the same
          date and remark applied individually, not one shared entry.
        </p>
        {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={busy}>
            {busy ? "Submitting..." : `Submit for ${groups.length} PO${groups.length !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* History is still per style line — that is where crd_updates rows live —
   but it is REACHED from the PO, and every line's history is shown together
   under one heading, because "what happened to this PO's date" is the
   question being asked. */
function CrdHistoryModal({ group, onClose }) {
  const [byLine, setByLine] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all(group.lines.map(l =>
      getCrdHistory(l.id).then(rows => ({ line: l, rows })).catch(e => ({ line: l, rows: [], error: e.message }))
    )).then(res => { if (!cancelled) setByLine(res); }).catch(e => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [group.key]);

  const showStyle = group.lineCount > 1;

  return (
    <div className="modal-backdrop">
      <div className="modal-box" style={{ width: 620 }}>
        <h3>CRD History — {group.po}</h3>
        {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
        {!byLine && !error && <p style={{ color: "#6B7280" }}>Loading...</p>}
        {byLine && (
          <div style={{ maxHeight: 420, overflowY: "auto" }}>
            {byLine.every(x => x.rows.length === 0) && (
              <p style={{ color: "#6B7280" }}>No CRD has been submitted for this PO yet.</p>
            )}
            {byLine.map(({ line, rows }) => rows.length === 0 ? null : (
              <div key={line.id} style={{ marginBottom: 14 }}>
                {showStyle && (
                  <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 4 }}>
                    Style {get(line, "style") || "—"}
                    {get(line, "colour") ? ` · ${get(line, "colour")}` : ""}
                  </div>
                )}
                {rows.length === 1 ? (
                  <p style={{ color: "#6B7280", margin: 0, fontSize: 13 }}>
                    No previous changes. Current CRD submitted on{" "}
                    {new Date(rows[0].created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" })}.
                  </p>
                ) : (
                  <table className="data-table">
                    <thead><tr><th>Date/Time</th><th>Previous CRD</th><th>New CRD</th><th>Submitted By</th><th>Source</th></tr></thead>
                    <tbody>
                      {rows.map(h => (
                        <tr key={h.id}>
                          <td>{new Date(h.created_at).toLocaleString()}</td>
                          <td>{h.previous_crd || "—"}</td>
                          <td>{h.new_crd}</td>
                          <td>{h.submittedByLabel}</td>
                          <td>{h.source === "portal" ? "Factory Portal" : h.source}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

const BLANK_FILTERS = { po: "", customer: "", productGroup: "", etdFrom: "", etdTo: "", status: "" };

export default function FactoryMyOrders() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useSticky("factory-orders", "selectedPos", []);
  const [expanded, setExpanded] = useSticky("factory-orders", "expanded", []);
  const [showCrdModal, setShowCrdModal] = useState(false);
  const [historyGroup, setHistoryGroup] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [filters, setFilters] = useSticky("factory-orders", "filters", BLANK_FILTERS);

  async function refresh() {
    setLoading(true); setError(null);
    try { setRows(await listMyOrders()); }
    catch (e) { setError(e.message); }
    setLoading(false);
  }
  useEffect(() => { refresh(); }, []);

  const groups = useMemo(() => groupByPo(rows), [rows]);
  const cols = useMemo(() => availableColumns(rows), [rows]);

  /* Filters read the PO, not the style line — with one deliberate exception.
     A factory searching for a style number is searching for the PO that
     contains it, so the PO filter matches either. Finding nothing because
     you typed a style into a box labelled PO is not a useful lesson. */
  const filtered = useMemo(() => groups.filter(g => {
    const q = filters.po.trim().toLowerCase();
    if (q) {
      const inPo = g.po.toLowerCase().includes(q);
      const inStyle = g.styles.some(s => String(s).toLowerCase().includes(q));
      if (!inPo && !inStyle) return false;
    }
    if (filters.customer && !String(g.customer || "").toLowerCase().includes(filters.customer.toLowerCase())) return false;
    if (filters.productGroup && !String(g.productGroup || "").toLowerCase().includes(filters.productGroup.toLowerCase())) return false;
    /* A date range must keep a PO whose styles STRADDLE it. Testing only the
       headline date would hide a PO that has work due inside the window
       just because its first style is due outside it. */
    if (filters.etdFrom || filters.etdTo) {
      const dates = g.lines.map(l => get(l, "etd")).filter(Boolean);
      if (dates.length === 0) return false;
      const anyInRange = dates.some(d =>
        (!filters.etdFrom || d >= filters.etdFrom) && (!filters.etdTo || d <= filters.etdTo));
      if (!anyInRange) return false;
    }
    if (filters.status && !g.statuses.includes(filters.status)) return false;
    return true;
  }), [groups, filters]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const selectedGroups = groups.filter(g => selectedSet.has(g.key));
  const statusOptions = useMemo(
    () => [...new Set(rows.map(r => get(r, "status")).filter(Boolean))], [rows]);

  function togglePo(key) {
    setSelected(selectedSet.has(key) ? selected.filter(k => k !== key) : [...selected, key]);
  }
  function toggleAllFiltered() {
    const keys = filtered.map(g => g.key);
    const allOn = keys.length > 0 && keys.every(k => selectedSet.has(k));
    setSelected(allOn ? [] : keys);
  }
  const expandedSet = useMemo(() => new Set(expanded), [expanded]);
  function toggleExpand(key) {
    setExpanded(expandedSet.has(key) ? expanded.filter(k => k !== key) : [...expanded, key]);
  }

  const totalQty = filtered.reduce((s, g) => s + (g.qty || 0), 0);
  const allQty = groups.reduce((s, g) => s + (g.qty || 0), 0);
  const styleTotal = groups.reduce((s, g) => s + (g.styleCount || g.lineCount), 0);
  /* The soonest date still ahead. A PO already past its date is not the
     "next" one — showing it there would make a card that is meant to answer
     "what is coming up" answer "what is late" instead. */
  const nextDelivery = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const upcoming = groups.map(g => g.etd).filter(d => d && d >= today).sort();
    return upcoming[0] || null;
  }, [groups]);
  const filtersOn = Object.keys(BLANK_FILTERS).some(k => filters[k] !== BLANK_FILTERS[k]);

  /* Columns are counted rather than hardcoded so the "nothing matches" row
     spans the table whatever the view happens to serve. */
  /* Eight fixed: select, expand, history, PO, ETD, Qty, Styles, Status. */
  const colCount = 8 + (cols.customer ? 1 : 0) + (cols.productGroup ? 1 : 0)
    + (cols.merchandiser ? 1 : 0) + (cols.crd ? 1 : 0);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
        <input placeholder="PO or style" value={filters.po} onChange={e => setFilters({ ...filters, po: e.target.value })} style={{ padding: 8, width: 130 }} />
        {cols.customer && <input placeholder="Customer" value={filters.customer} onChange={e => setFilters({ ...filters, customer: e.target.value })} style={{ padding: 8, width: 130 }} />}
        {cols.productGroup && <input placeholder="Product Group" value={filters.productGroup} onChange={e => setFilters({ ...filters, productGroup: e.target.value })} style={{ padding: 8, width: 140 }} />}
        <input type="date" value={filters.etdFrom} onChange={e => setFilters({ ...filters, etdFrom: e.target.value })} style={{ padding: 8 }} />
        <span style={{ alignSelf: "center", color: "#9CA3AF" }}>to</span>
        <input type="date" value={filters.etdTo} onChange={e => setFilters({ ...filters, etdTo: e.target.value })} style={{ padding: 8 }} />
        <select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })} style={{ padding: 8 }}>
          <option value="">All Statuses</option>
          {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {filtersOn && <button className="btn-outline" onClick={() => setFilters(BLANK_FILTERS)}>Clear</button>}
      </div>

      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
      {confirmation && <p style={{ color: "#15803D" }}>CRD submitted for {confirmation} PO{confirmation !== 1 ? "s" : ""}.</p>}

      {!loading && rows.length > 0 && (
        <div className="fp-cards">
          <div className="fp-card">
            <span className="fp-card-n">{groups.length}</span>
            <span className="fp-card-l">Purchase orders</span>
          </div>
          <div className="fp-card">
            <span className="fp-card-n">{allQty.toLocaleString()}</span>
            <span className="fp-card-l">Pieces booked</span>
          </div>
          <div className="fp-card">
            <span className="fp-card-n">{nextDelivery || "—"}</span>
            <span className="fp-card-l">Next delivery</span>
          </div>
          <div className="fp-card">
            <span className="fp-card-n">{styleTotal}</span>
            <span className="fp-card-l">Styles in hand</span>
          </div>
        </div>
      )}

      {loading ? <p>Loading...</p> : rows.length === 0 ? (
        <p style={{ color: "#6B7280" }}>No orders assigned to your factory yet. If you were just linked to a factory, this will update automatically — no need to log out and back in.</p>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 12, flexWrap: "wrap" }}>
            <label style={{ fontSize: 13 }}>
              <input type="checkbox" checked={filtered.length > 0 && filtered.every(g => selectedSet.has(g.key))} onChange={toggleAllFiltered} />
              {" "}Select all filtered ({filtered.length} PO{filtered.length !== 1 ? "s" : ""}
              {totalQty ? `, ${totalQty.toLocaleString()} pcs` : ""})
            </label>
            <button className="btn-primary" disabled={selectedGroups.length === 0} onClick={() => setShowCrdModal(true)}>
              Update CRD ({selectedGroups.length} PO{selectedGroups.length !== 1 ? "s" : ""} selected)
            </button>
          </div>

          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 26 }}></th>
                <th style={{ width: 26 }}></th>
                <th style={{ width: 26 }}></th>
                <th>PO</th>
                <th>ETD</th>
                <th>Qty</th>
                <th>Styles</th>
                {cols.customer && <th>Customer</th>}
                {cols.productGroup && <th>Product Group</th>}
                {cols.merchandiser && <th>Merchandiser</th>}
                {cols.crd && <th>Current CRD</th>}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(g => {
                const open = expandedSet.has(g.key);
                return (
                  <React.Fragment key={g.key}>
                    <tr>
                      <td><input type="checkbox" checked={selectedSet.has(g.key)} onChange={() => togglePo(g.key)} /></td>
                      <td>
                        <button title={open ? "Collapse" : "Show styles and colours"} onClick={() => toggleExpand(g.key)}
                          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 12, color: "#6B7280", padding: 0, width: 18 }}>
                          {open ? "▾" : "▸"}
                        </button>
                      </td>
                      <td>
                        <button title="CRD History" onClick={() => setHistoryGroup(g)}
                          style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15, padding: 0 }}>🕐</button>
                      </td>
                      <td><strong>{g.po}</strong></td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {g.etdMixed && g.etdRange
                          ? <>{g.etdRange.from} – {g.etdRange.to}<MixedTag>mixed</MixedTag></>
                          : (g.etd || "—")}
                      </td>
                      <td className="num">{g.qty != null ? g.qty.toLocaleString() : "—"}</td>
                      <td className="num">{g.styleCount || g.lineCount}</td>
                      {cols.customer && <td>{g.customer || "—"}{g.customerMixed && <MixedTag>mixed</MixedTag>}</td>}
                      {cols.productGroup && <td>{g.productGroup || "—"}{g.productGroupMixed && <MixedTag>mixed</MixedTag>}</td>}
                      {cols.merchandiser && <td>{g.merchandiser || "—"}{g.merchandiserMixed && <MixedTag>mixed</MixedTag>}</td>}
                      {cols.crd && <td>{g.crd || "—"}{g.crdMixed && <MixedTag>mixed</MixedTag>}</td>}
                      <td>{g.statusMixed ? <>{g.statuses.join(", ")}<MixedTag>mixed</MixedTag></> : (g.status || "—")}</td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={colCount} style={{ background: "#F9FAFB", padding: "6px 10px 10px 34px" }}>
                          <table className="data-table" style={{ margin: 0 }}>
                            <thead>
                              <tr>
                                {cols.style && <th>Style</th>}
                                {cols.colour && <th>Colour</th>}
                                <th>Qty</th>
                                <th>ETD</th>
                                {cols.crd && <th>Current CRD</th>}
                                <th>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {g.lines.flatMap(l => {
                                /* A style line may carry several colours. It is
                                   expanded into one row per colour when it does,
                                   because that is the level the factory cuts and
                                   packs at — and the quantities are the colour's
                                   own, never the style total repeated down the
                                   rows, which would read as four times the work.
                                   A line with no colour breakdown stays one row
                                   rather than inventing a colour for it. */
                                const ways = Array.isArray(l.colour_ways) ? l.colour_ways : [];
                                const style = get(l, "style") || "—";
                                if (ways.length <= 1) return [(
                                  <tr key={l.id}>
                                    {cols.style && <td>{style}</td>}
                                    {cols.colour && <td>{ways[0]?.name || get(l, "colour") || "—"}</td>}
                                    <td className="num">{get(l, "qty") != null ? Number(get(l, "qty")).toLocaleString() : "—"}</td>
                                    <td>{get(l, "etd") || "—"}</td>
                                    {cols.crd && <td>{get(l, "crd") || "—"}</td>}
                                    <td>{get(l, "status") || "—"}</td>
                                  </tr>
                                )];
                                return ways.map((w, i) => (
                                  <tr key={`${l.id}:${w.name}`}>
                                    {cols.style && <td>{i === 0 ? style : ""}</td>}
                                    {cols.colour && <td>{w.name || "—"}</td>}
                                    <td className="num">{w.qty != null ? Number(w.qty).toLocaleString() : "—"}</td>
                                    <td>{i === 0 ? (get(l, "etd") || "—") : ""}</td>
                                    {cols.crd && <td>{i === 0 ? (get(l, "crd") || "—") : ""}</td>}
                                    <td>{i === 0 ? (get(l, "status") || "—") : ""}</td>
                                  </tr>
                                ));
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {filtered.length === 0 && <tr><td colSpan={colCount}>No POs match this filter.</td></tr>}
            </tbody>
          </table>
        </>
      )}

      {showCrdModal && (
        <CrdModal
          groups={selectedGroups}
          onClose={() => setShowCrdModal(false)}
          onSubmitted={(count) => { setShowCrdModal(false); setSelected([]); setConfirmation(count); refresh(); }}
        />
      )}
      {historyGroup && <CrdHistoryModal group={historyGroup} onClose={() => setHistoryGroup(null)} />}
    </div>
  );
}
