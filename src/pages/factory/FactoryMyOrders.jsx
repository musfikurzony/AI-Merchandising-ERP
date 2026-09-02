import React, { useEffect, useMemo, useState } from "react";
import { listMyOrders, submitCrdUpdate, getCrdHistory } from "../../lib/factoryApi.js";

function CrdModal({ selectedOrders, onClose, onSubmitted }) {
  const [newCrd, setNewCrd] = useState("");
  const [remarks, setRemarks] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function handleSubmit() {
    if (!newCrd) { setError("New CRD date is required."); return; }
    setBusy(true); setError(null);
    try {
      const results = await submitCrdUpdate(selectedOrders.map(o => o.id), newCrd, remarks);
      const failures = results.filter(r => r.error);
      if (failures.length) {
        setError(`${failures.length} of ${results.length} orders failed: ${failures[0].error}`);
      } else {
        onSubmitted(results.length);
      }
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-box" style={{ width: 480 }}>
        <h3>Update CRD — {selectedOrders.length} order{selectedOrders.length !== 1 ? "s" : ""}</h3>
        <div style={{ maxHeight: 120, overflowY: "auto", fontSize: 12, color: "#6B7280", marginBottom: 12 }}>
          {selectedOrders.map(o => <div key={o.id}>{o.po}</div>)}
        </div>
        <label className="field">New CRD
          <input type="date" value={newCrd} onChange={e => setNewCrd(e.target.value)} />
        </label>
        <label className="field">Remarks (applied to all selected orders)
          <input value={remarks} onChange={e => setRemarks(e.target.value)} />
        </label>
        <p style={{ fontSize: 12, color: "#6B7280" }}>
          Each order gets its own CRD record — this isn't one shared entry,
          it's the same date and remark applied individually to every order
          you selected, so each one's history and notifications stay accurate.
        </p>
        {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={busy}>
            {busy ? "Submitting..." : `Submit for ${selectedOrders.length} Order${selectedOrders.length !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* Reuses crd_updates entirely -- no separate history table. Each row is a
   real submission, newest first; previous_crd on each row is the CRD that
   was on file immediately before that specific submission (auto-populated
   by the database trigger, not computed here). */
function CrdHistoryModal({ order, onClose }) {
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getCrdHistory(order.id).then(setHistory).catch(e => setError(e.message));
  }, [order.id]);

  return (
    <div className="modal-backdrop">
      <div className="modal-box" style={{ width: 520 }}>
        <h3>CRD History — {order.po}</h3>
        {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
        {!history && !error && <p style={{ color: "#6B7280" }}>Loading...</p>}
        {history && history.length === 1 && (
          <p style={{ color: "#6B7280" }}>
            No previous CRD changes.<br />
            Current CRD was submitted on {new Date(history[0].created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" })}.
          </p>
        )}
        {history && history.length > 1 && (
          <table className="data-table">
            <thead><tr><th>Date/Time</th><th>Previous CRD</th><th>New CRD</th><th>Submitted By</th><th>Source</th></tr></thead>
            <tbody>
              {history.map(h => (
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
        {history && history.length === 0 && <p style={{ color: "#6B7280" }}>No CRD has been submitted for this order yet.</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

export default function FactoryMyOrders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [showCrdModal, setShowCrdModal] = useState(false);
  const [historyOrder, setHistoryOrder] = useState(null);
  const [confirmation, setConfirmation] = useState(null);

  const [filters, setFilters] = useState({ po: "", customer: "", productGroup: "", etdFrom: "", etdTo: "", status: "" });

  async function refresh() {
    setLoading(true); setError(null);
    try { setOrders(await listMyOrders()); }
    catch (e) { setError(e.message); }
    setLoading(false);
  }
  useEffect(() => { refresh(); }, []);

  const filtered = useMemo(() => orders.filter(o => {
    if (filters.po && !o.po.toLowerCase().includes(filters.po.toLowerCase())) return false;
    if (filters.customer && !(o.customer_name || "").toLowerCase().includes(filters.customer.toLowerCase())) return false;
    if (filters.productGroup && !(o.product_group_name || "").toLowerCase().includes(filters.productGroup.toLowerCase())) return false;
    if (filters.etdFrom && o.etd < filters.etdFrom) return false;
    if (filters.etdTo && o.etd > filters.etdTo) return false;
    if (filters.status && o.shipment_status_label !== filters.status) return false;
    return true;
  }), [orders, filters]);

  const selectedOrders = orders.filter(o => selected.has(o.id));
  const statusOptions = useMemo(() => [...new Set(orders.map(o => o.shipment_status_label))], [orders]);

  function toggleOne(id) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  }
  function toggleAllFiltered() {
    const filteredIds = filtered.map(o => o.id);
    const allSelected = filteredIds.every(id => selected.has(id));
    setSelected(allSelected ? new Set() : new Set(filteredIds));
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        <input placeholder="PO" value={filters.po} onChange={e => setFilters({ ...filters, po: e.target.value })} style={{ padding: 8, width: 110 }} />
        <input placeholder="Customer" value={filters.customer} onChange={e => setFilters({ ...filters, customer: e.target.value })} style={{ padding: 8, width: 130 }} />
        <input placeholder="Product Group" value={filters.productGroup} onChange={e => setFilters({ ...filters, productGroup: e.target.value })} style={{ padding: 8, width: 140 }} />
        <input type="date" value={filters.etdFrom} onChange={e => setFilters({ ...filters, etdFrom: e.target.value })} style={{ padding: 8 }} />
        <span style={{ alignSelf: "center", color: "#9CA3AF" }}>to</span>
        <input type="date" value={filters.etdTo} onChange={e => setFilters({ ...filters, etdTo: e.target.value })} style={{ padding: 8 }} />
        <select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value })} style={{ padding: 8 }}>
          <option value="">All Statuses</option>
          {statusOptions.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
      {confirmation && <p style={{ color: "#15803D" }}>CRD submitted for {confirmation} order{confirmation !== 1 ? "s" : ""}.</p>}

      {loading ? <p>Loading...</p> : orders.length === 0 ? (
        <p style={{ color: "#6B7280" }}>No orders assigned to your factory yet. If you were just linked to a factory, this will update automatically — no need to log out and back in.</p>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <label style={{ fontSize: 13 }}>
              <input type="checkbox" checked={filtered.length > 0 && filtered.every(o => selected.has(o.id))} onChange={toggleAllFiltered} /> Select all filtered ({filtered.length})
            </label>
            <button className="btn-primary" disabled={selected.size === 0} onClick={() => setShowCrdModal(true)}>
              Update CRD ({selected.size} selected)
            </button>
          </div>
          <table className="data-table">
            <thead><tr><th></th><th></th><th>PO</th><th>ETD</th><th>Qty</th><th>Customer</th><th>Product Group</th><th>Current CRD</th><th>Status</th></tr></thead>
            <tbody>
              {filtered.map(o => (
                <tr key={o.id}>
                  <td><input type="checkbox" checked={selected.has(o.id)} onChange={() => toggleOne(o.id)} /></td>
                  <td><button title="CRD History" onClick={() => setHistoryOrder(o)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 15 }}>🕐</button></td>
                  <td>{o.po}</td><td>{o.etd}</td><td>{o.ordered_qty}</td>
                  <td>{o.customer_name || "—"}</td><td>{o.product_group_name || "—"}</td>
                  <td>{o.current_crd || "—"}</td><td>{o.shipment_status_label}</td>
                </tr>
              ))}
              {filtered.length === 0 && <tr><td colSpan={9}>No orders match this filter.</td></tr>}
            </tbody>
          </table>
        </>
      )}

      {showCrdModal && (
        <CrdModal
          selectedOrders={selectedOrders}
          onClose={() => setShowCrdModal(false)}
          onSubmitted={(count) => { setShowCrdModal(false); setSelected(new Set()); setConfirmation(count); refresh(); }}
        />
      )}
      {historyOrder && <CrdHistoryModal order={historyOrder} onClose={() => setHistoryOrder(null)} />}
    </div>
  );
}
