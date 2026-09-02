import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { listOrders, getOrderColorWays, splitOrderDelivery } from "../lib/ordersApi.js";
import {
  listShipments, getShipment, createShipment, updateShipment,
  getShipmentLines, addShipmentLine, updateShipmentLine, deleteShipmentLine, lockShipment, unlockShipment,
  getShipmentSummaryForOrder, getShipmentLineTotals,
} from "../lib/shipmentApi.js";

/* Shipping Portal, built on shipments/shipment_lines (Migrations 24-25,
   locking from 28/34) -- order_shipments is never referenced. Current
   shipment lives in the URL (/shipping/:shipmentId). Locking includes a
   24-hour unlock window (Migration 34), computed live, no background job. */

function fmtDate(d) { return d ? new Date(d).toLocaleDateString() : "—"; }
function fmtNum(n) { return n == null ? "—" : Number(n).toLocaleString("en-US"); }
function fmtMoney(n) { return n == null ? "—" : `$${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`; }

function StatusBadge({ locked, withinUnlockWindow, unlockedUntil }) {
  if (locked) return <span className="pill" style={{ background: "#FEE2E2", color: "#B91C1C" }}>LOCKED</span>;
  if (withinUnlockWindow) return <span className="pill" style={{ background: "#FEF3C7", color: "#B45309" }}>UNLOCKED UNTIL {unlockedUntil.toLocaleString()}</span>;
  return <span className="pill" style={{ background: "#DCFCE7", color: "#15803D" }}>OPEN</span>;
}

function ShipmentsList() {
  const navigate = useNavigate();
  const [shipments, setShipments] = useState([]);
  const [totals, setTotals] = useState(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function refresh() {
    setLoading(true); setError(null);
    try {
      const s = await listShipments();
      setShipments(s);
      setTotals(await getShipmentLineTotals(s.map(x => x.id)));
    } catch (e) { setError(e.message); }
    setLoading(false);
  }
  useEffect(() => { refresh(); }, []);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Shipments</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn-ghost-sm" onClick={() => navigate("/shipping-reports")}>📊 Shipping Reports</button>
          <button className="btn-primary" onClick={() => navigate("/shipping/new")}>+ New Shipment</button>
        </div>
      </div>
      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
      {loading ? <p>Loading...</p> : (
        <div className="card no-pad">
          <table className="data-table">
            <thead><tr><th>Invoice #</th><th>Vessel</th><th>Booking Date</th><th>Destination</th><th>Lines</th><th>Value</th><th>Created By</th><th>Status</th></tr></thead>
            <tbody>
              {shipments.map(s => {
                const t = totals.get(s.id);
                const locked = !!s.locked_at && (!s.unlocked_at || new Date(s.unlocked_at).getTime() + 24 * 3600 * 1000 <= Date.now());
                const withinWindow = !!s.locked_at && s.unlocked_at && new Date(s.unlocked_at).getTime() + 24 * 3600 * 1000 > Date.now();
                return (
                  <tr key={s.id} style={{ cursor: "pointer" }} onClick={() => navigate(`/shipping/${s.id}`)}>
                    <td className="strong">{s.invoice_number || "—"}</td>
                    <td>{s.vessel || "—"}</td>
                    <td className="mono">{fmtDate(s.booking_date)}</td>
                    <td>{s.destination_port || "—"}</td>
                    <td className="mono">{t ? `${t.lineCount} line(s)` : "0 lines"}</td>
                    <td className="mono">{t?.totalValue ? fmtMoney(t.totalValue) : "—"}</td>
                    <td>{s.profiles?.full_name || "—"}</td>
                    <td><StatusBadge locked={locked} withinUnlockWindow={withinWindow} unlockedUntil={s.unlocked_at ? new Date(new Date(s.unlocked_at).getTime() + 24 * 3600 * 1000) : null} /></td>
                  </tr>
                );
              })}
              {shipments.length === 0 && <tr><td colSpan={8} className="empty-row">No shipments yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* Multi-PO shipment workbench. Works even for a shipment that doesn't
   exist in the database yet (isNew=true) -- selecting the first PO
   silently creates the shipment header behind the scenes (using whatever
   header fields have already been typed), then proceeds exactly as
   normal. Confirmed as a real gap otherwise: the PO search was
   previously hidden entirely until the shipment was saved, forcing a
   save-an-empty-shipment-first step nobody wanted.

   Clicking a search result immediately loads and expands its colors.
   Selected POs collect into a persistent "Selected POs for This
   Shipment" table, each row summarizing PO/Style/Factory/Customer/Order
   Qty/Shipped Qty/Value, click to expand/collapse the color-level detail
   -- searching again never hides what's already selected. */
/* Multi-PO shipment workbench. Redesigned around one explicit, fixed
   control: a real checkbox per color, at a fixed left position,
   independent of clicking anywhere else in the row. Confirmed a real bug
   causing the reported instability while investigating this: removing a
   staged PO never cleaned up its quantity/price entries, so re-adding
   the same PO later silently reused stale values from the earlier
   session -- exactly matching "different colors suddenly appear." Fixed
   by clearing every piece of state tied to an order the moment it's
   removed, not just the staged list itself.

   Works even for a shipment that doesn't exist in the database yet
   (isNew=true) -- selecting the first PO silently creates the shipment
   header behind the scenes. */
/* Multi-PO shipment workbench, redesigned as two deliberate phases per
   the explicit spec: Phase 1 (selecting) is pure browse-and-tick, no
   quantity or price entry at all -- search groups results by PO (not
   one row per style, since a PO can span several styles), expands to
   Style -> Color with a real checkbox per color and read-only
   Order/Previously-Shipped/Balance context. A persistent "Selected for
   this Invoice" basket stays visible throughout, and the selection is
   never disturbed by searching again. Only pressing "Add Selected POs to
   Shipment" moves into Phase 2 (entering), where the shipment
   qty/price inputs finally appear for exactly what was selected. */
function AddLinePanel({ shipmentId, isNew, headerForm, onShipmentCreated, onAdded }) {
  const [phase, setPhase] = useState("selecting"); // "selecting" | "entering"
  const [query, setQuery] = useState("");
  const [candidateOrders, setCandidateOrders] = useState([]);
  const [expandedPOs, setExpandedPOs] = useState(new Set()); // "poPrefix|poNumber"
  const [loadedColorWays, setLoadedColorWays] = useState(new Map()); // orderId -> [{color, orderedQty, shippedQty, balance}]
  const [loadingOrderId, setLoadingOrderId] = useState(null);
  const [checkedColors, setCheckedColors] = useState(new Set()); // "orderId|color" -- persists across searches and across phases
  const [qtyByKey, setQtyByKey] = useState({});
  const [priceByKey, setPriceByKey] = useState({});
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { listOrders({ status: "shipped" }).then(setCandidateOrders); }, []);

  function groupByPO(orders) {
    const groups = new Map();
    for (const o of orders) {
      const key = `${o.po_prefix}|${o.po_number}`;
      if (!groups.has(key)) groups.set(key, { poPrefix: o.po_prefix, poNumber: o.po_number, factory: o.factories?.name, label: o.labels?.name, customer: o.customers?.name, etd: o.etd, totalOrderQty: 0, styles: [] });
      const g = groups.get(key);
      g.totalOrderQty += o.qty;
      g.styles.push(o);
    }
    return [...groups.values()];
  }

  const matches = query.length < 2 ? [] : groupByPO(
    candidateOrders.filter(o => `${o.po_prefix}${o.po_number} ${o.style} ${o.customers?.name || ""} ${o.labels?.name || ""}`.toLowerCase().includes(query.toLowerCase()))
  ).slice(0, 10);

  async function togglePO(poKey, styles) {
    setExpandedPOs(prev => { const next = new Set(prev); if (next.has(poKey)) next.delete(poKey); else next.add(poKey); return next; });
    // Lazily load color-ways for every style under this PO the first time it's expanded -- cached afterward.
    for (const s of styles) {
      if (loadedColorWays.has(s.id)) continue;
      setLoadingOrderId(s.id);
      try {
        const colorWays = await getOrderColorWays(s.id);
        const summary = await getShipmentSummaryForOrder(s.id, colorWays);
        setLoadedColorWays(prev => new Map(prev).set(s.id, summary));
      } catch (e) { setError(e.message); }
    }
    setLoadingOrderId(null);
  }

  function toggleColor(orderId, color) {
    const key = `${orderId}|${color}`;
    setCheckedColors(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  }

  // The selection basket -- built entirely from checkedColors + whatever
  // color-way data has been loaded, independent of the current search
  // query, so it never loses earlier POs when searching for another one.
  const basketKeys = [...checkedColors];
  const basketByOrder = new Map();
  for (const key of basketKeys) {
    const [orderId, color] = key.split("|");
    const order = candidateOrders.find(o => o.id === orderId);
    const cw = (loadedColorWays.get(orderId) || []).find(c => c.color === color);
    if (!order || !cw) continue;
    if (!basketByOrder.has(orderId)) basketByOrder.set(orderId, { order, colors: [] });
    basketByOrder.get(orderId).colors.push(cw);
  }
  const basketPOs = new Set([...basketByOrder.values()].map(b => `${b.order.po_prefix}|${b.order.po_number}`));
  const basketStyles = basketByOrder.size;
  const basketColors = basketKeys.length;
  const basketOrderedQty = [...basketByOrder.values()].reduce((s, b) => s + b.colors.reduce((a, cw) => a + cw.orderedQty, 0), 0);
  const basketShippedQty = [...basketByOrder.values()].reduce((s, b) => s + b.colors.reduce((a, cw) => a + cw.shippedQty, 0), 0);
  const basketBalance = basketOrderedQty - basketShippedQty;

  function setQty(orderId, color, value) { setQtyByKey(prev => ({ ...prev, [`${orderId}|${color}`]: value })); }
  function setPrice(orderId, color, value) { setPriceByKey(prev => ({ ...prev, [`${orderId}|${color}`]: value })); }
  function fillRemaining(orderId) {
    const b = basketByOrder.get(orderId);
    setQtyByKey(prev => { const next = { ...prev }; for (const cw of b.colors) if (cw.balance > 0) next[`${orderId}|${cw.color}`] = String(cw.balance); return next; });
  }
  function removeFromBasket(orderId, color) {
    const key = `${orderId}|${color}`;
    setCheckedColors(prev => { const next = new Set(prev); next.delete(key); return next; });
    setQtyByKey(prev => { const { [key]: _, ...rest } = prev; return rest; });
    setPriceByKey(prev => { const { [key]: _, ...rest } = prev; return rest; });
  }

  const enteredLines = [];
  const excessLines = [];
  for (const [orderId, b] of basketByOrder) {
    for (const cw of b.colors) {
      const key = `${orderId}|${cw.color}`;
      const qty = Number(qtyByKey[key]);
      if (qty > 0) {
        const line = { orderId, po: `${b.order.po_prefix}${b.order.po_number}`, color: cw.color, qty, balance: cw.balance, price: priceByKey[key] ? Number(priceByKey[key]) : null };
        enteredLines.push(line);
        if (qty > cw.balance) excessLines.push(line);
      }
    }
  }
  const shipmentTotalQty = enteredLines.reduce((s, l) => s + l.qty, 0);
  const shipmentTotalValue = enteredLines.reduce((s, l) => s + l.qty * (l.price || 0), 0);

  async function saveAll() {
    if (!enteredLines.length) { setError("Enter a shipment quantity for at least one color."); return; }
    if (excessLines.length) {
      const msg = "Shipped quantity differs from remaining balance:\n\n"
        + excessLines.map(l => `${l.po} / ${l.color}: remaining ${fmtNum(l.balance)}, shipping ${fmtNum(l.qty)} (+${fmtNum(l.qty - l.balance)})`).join("\n")
        + "\n\nDo you want to proceed with this excess shipment quantity?";
      if (!window.confirm(msg)) return;
    }
    setSaving(true); setError(null);
    try {
      const realId = shipmentId === "new" ? null : shipmentId;
      for (const l of enteredLines) await addShipmentLine(realId, l.orderId, l.color, l.qty, l.price);

      const shortByOrder = new Map();
      for (const [orderId, b] of basketByOrder) {
        for (const cw of b.colors) {
          const key = `${orderId}|${cw.color}`;
          const qty = Number(qtyByKey[key]) || 0;
          const remaining = cw.balance - qty;
          if (qty > 0 && remaining > 0) {
            if (!shortByOrder.has(orderId)) shortByOrder.set(orderId, { order: b.order, colors: {} });
            shortByOrder.get(orderId).colors[cw.color] = remaining;
          }
        }
      }
      for (const { order, colors } of shortByOrder.values()) {
        const total = Object.values(colors).reduce((a, b) => a + b, 0);
        const colorList = Object.entries(colors).map(([c, q]) => `${c}: ${fmtNum(q)}`).join(", ");
        const msg = `${order.po_prefix}${order.po_number} shipped short by ${fmtNum(total)} pcs (${colorList}).\n\n`
          + `Is this a split shipment — will the remaining balance go out with a later delivery?\n\n`
          + `Choosing OK creates a new "Delivery" order automatically for the remaining balance, which you can then give its own ETD and keep open. Choosing Cancel leaves the balance recorded against this order only.`;
        if (window.confirm(msg)) {
          try {
            await splitOrderDelivery(order.id, colors);
            window.alert(`Created a new delivery for ${order.po_prefix}${order.po_number} — open it from Orders to set its ETD.`);
          } catch (e) { setError(e.message); }
        }
      }

      setCheckedColors(new Set()); setQtyByKey({}); setPriceByKey({}); setPhase("selecting");
      await onAdded();
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  const BasketSummary = () => (
    <div style={{ padding: "10px 14px", background: "#EEF2FF", borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
      <b>Selected for this Invoice:</b> {basketPOs.size} PO(s) · {basketStyles} style(s) · {basketColors} color(s) · {fmtNum(basketOrderedQty)} pcs ordered
      {basketShippedQty > 0 && <> · {fmtNum(basketShippedQty)} previously shipped · {fmtNum(basketBalance)} balance</>}
    </div>
  );

  if (phase === "entering") {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <div style={{ fontWeight: 600 }}>Enter Shipment Quantities</div>
          <button className="btn-ghost-sm" onClick={() => setPhase("selecting")}>← Back to Selection</button>
        </div>
        {error && <p style={{ color: "#B91C1C", fontSize: 13 }}>{error}</p>}
        {[...basketByOrder.entries()].map(([orderId, b]) => (
          <div key={orderId} style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid #F2F3F6" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <b>{b.order.po_prefix}{b.order.po_number}</b> · {b.order.style}
              <button className="btn-ghost-sm" onClick={() => fillRemaining(orderId)}>Fill Remaining Qty</button>
            </div>
            <table className="data-table">
              <thead><tr><th>Color</th><th>Order Qty</th><th>Previously Shipped</th><th>Balance</th><th>This Shipment</th><th>Unit Price</th><th></th></tr></thead>
              <tbody>
                {b.colors.map(cw => {
                  const key = `${orderId}|${cw.color}`;
                  const qty = Number(qtyByKey[key]) || 0;
                  const isExcess = qty > cw.balance;
                  const isShort = qty > 0 && qty < cw.balance;
                  return (
                    <tr key={cw.color}>
                      <td>{cw.color}</td><td className="mono">{fmtNum(cw.orderedQty)}</td><td className="mono">{fmtNum(cw.shippedQty)}</td>
                      <td className="mono" style={{ color: cw.balance === 0 ? "#15803D" : "#B45309" }}>{fmtNum(cw.balance)}</td>
                      <td>
                        <input type="number" min="0" value={qtyByKey[key] || ""} onChange={e => setQty(orderId, cw.color, e.target.value)} style={{ width: 90, padding: 4, border: isExcess ? "1px solid #B91C1C" : undefined }} />
                        {isExcess && <div style={{ fontSize: 11, color: "#B91C1C" }}>⚠️ +{fmtNum(qty - cw.balance)} over</div>}
                        {isShort && <div style={{ fontSize: 11, color: "#9CA3AF" }}>partial · {fmtNum(cw.balance - qty)} left</div>}
                      </td>
                      <td><input type="number" step="0.01" min="0" value={priceByKey[key] || ""} onChange={e => setPrice(orderId, cw.color, e.target.value)} style={{ width: 90, padding: 4 }} /></td>
                      <td><button className="btn-ghost-sm" style={{ color: "#B91C1C" }} onClick={() => removeFromBasket(orderId, cw.color)}>Remove</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
        <div style={{ marginTop: 16, padding: 14, background: "#F9FAFB", borderRadius: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Shipment Summary</div>
          <div className="muted-sm">Total Shipment Qty: {fmtNum(shipmentTotalQty)} pcs · Total Shipment Value: {fmtMoney(shipmentTotalValue)}</div>
          {excessLines.length > 0 && <div style={{ marginTop: 8, color: "#B91C1C", fontSize: 12.5 }}>⚠️ {excessLines.length} color(s) exceed remaining balance — you'll be asked to confirm before saving.</div>}
          <button className="btn-primary" style={{ marginTop: 10 }} onClick={saveAll} disabled={saving || !enteredLines.length}>{saving ? "Saving..." : `Save ${enteredLines.length} Shipment Line(s)`}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 10 }}>+ Add POs to Shipment</div>
      {error && <p style={{ color: "#B91C1C", fontSize: 13 }}>{error}</p>}

      {basketColors > 0 && <BasketSummary />}

      <input placeholder="Search PO, style, customer, label…" value={query} onChange={e => setQuery(e.target.value)} style={{ padding: 8, width: "100%", marginBottom: 8 }} />
      {matches.map(po => {
        const poKey = `${po.poPrefix}|${po.poNumber}`;
        const isOpen = expandedPOs.has(poKey);
        return (
          <div key={poKey} style={{ border: "1px solid #E5E7EB", borderRadius: 8, marginBottom: 8, overflow: "hidden" }}>
            <div style={{ padding: 10, cursor: "pointer", display: "flex", justifyContent: "space-between", background: "#F9FAFB" }} onClick={() => togglePO(poKey, po.styles)}>
              <div>{isOpen ? "▾" : "▸"} <span className="mono strong">{po.poPrefix}{po.poNumber}</span> — {po.factory || "—"} · {po.label || "—"} · {po.customer || "—"}</div>
              <div className="muted-sm">Total Order Qty: {fmtNum(po.totalOrderQty)} · ETD: {po.etd || "—"}</div>
            </div>
            {isOpen && (
              <div style={{ padding: "8px 12px" }}>
                {po.styles.map(s => {
                  const colorWays = loadedColorWays.get(s.id);
                  return (
                    <div key={s.id} style={{ marginBottom: 10 }}>
                      <div style={{ fontWeight: 600, fontSize: 12.5, margin: "6px 0" }}>{s.style} — Order Qty {fmtNum(s.qty)}</div>
                      {!colorWays ? <p className="muted-sm">{loadingOrderId === s.id ? "Loading colors..." : ""}</p> : (
                        <table className="data-table">
                          <thead><tr><th></th><th>Color</th><th>Order Qty</th><th>Previously Shipped</th><th>Balance</th></tr></thead>
                          <tbody>
                            {colorWays.map(cw => (
                              <tr key={cw.color}>
                                <td><input type="checkbox" checked={checkedColors.has(`${s.id}|${cw.color}`)} onChange={() => toggleColor(s.id, cw.color)} /></td>
                                <td>{cw.color}</td><td className="mono">{fmtNum(cw.orderedQty)}</td><td className="mono">{fmtNum(cw.shippedQty)}</td>
                                <td className="mono" style={{ color: cw.balance === 0 ? "#15803D" : "#B45309" }}>{fmtNum(cw.balance)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {basketColors > 0 && (
        <div style={{ marginTop: 12 }}>
          <button className="btn-primary" onClick={() => setPhase("entering")}>Add Selected POs to Shipment ({basketColors} color{basketColors === 1 ? "" : "s"})</button>
        </div>
      )}
    </div>
  );
}


function EditLineRow({ line, onSaved, onCancel }) {
  const [qty, setQty] = useState(String(line.shipped_qty));
  const [price, setPrice] = useState(line.unit_price != null ? String(line.unit_price) : "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function save() {
    if (!Number(qty) || Number(qty) <= 0) { setError("Enter a shipped quantity greater than zero."); return; }
    setSaving(true); setError(null);
    try { await updateShipmentLine(line.id, Number(qty), price ? Number(price) : null); await onSaved(); }
    catch (e) { setError(e.message); }
    setSaving(false);
  }

  return (
    <tr>
      <td className="mono strong">{line.orders?.po_prefix}{line.orders?.po_number}</td>
      <td className="mono">{line.orders?.style}</td>
      <td>{line.color_way_name || "—"}</td>
      <td><input type="number" min="0" value={qty} onChange={e => setQty(e.target.value)} style={{ width: 90, padding: 4 }} /></td>
      <td><input type="number" step="0.01" min="0" value={price} onChange={e => setPrice(e.target.value)} style={{ width: 90, padding: 4 }} /></td>
      <td className="mono">{fmtMoney((Number(qty) || 0) * (Number(price) || 0))}</td>
      <td style={{ display: "flex", gap: 6 }}>
        <button className="btn-primary" style={{ padding: "4px 10px" }} onClick={save} disabled={saving}>{saving ? "..." : "Save"}</button>
        <button className="btn-ghost-sm" onClick={onCancel}>Cancel</button>
      </td>
      {error && <td style={{ color: "#B91C1C", fontSize: 11.5 }}>{error}</td>}
    </tr>
  );
}

const BLANK_HEADER = { vessel: "", booking_date: "", actual_etd: "", actual_eta: "", destination_port: "", consignee_name: "", invoice_number: "", invoice_date: "", invoice_value: "" };

/* Confirmed root cause of "invalid input syntax for type date: ''":
   the header form's blank optional fields were spread directly into the
   insert/update payload as empty strings -- fine for text columns, but
   Postgres rejects an empty string for a date column outright, not just
   invoice_value (which was the only field previously sanitized). One
   function, used at every place a header gets created or updated, so
   this can't drift out of sync between the two call sites again. */
function sanitizeHeaderPayload(form) {
  const out = {};
  for (const [key, value] of Object.entries(form)) out[key] = value === "" ? null : value;
  if (out.invoice_value != null) out.invoice_value = Number(out.invoice_value);
  return out;
}

function ShipmentDetail({ shipmentId }) {
  const navigate = useNavigate();
  const isNew = shipmentId === "new";
  const [shipment, setShipment] = useState(null);
  const [lines, setLines] = useState([]);
  const [editingLineId, setEditingLineId] = useState(null);
  const [form, setForm] = useState(BLANK_HEADER);
  const [loading, setLoading] = useState(!isNew);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [unlockReason, setUnlockReason] = useState("");
  const [showUnlock, setShowUnlock] = useState(false);

  async function refresh() {
    if (isNew) return;
    setLoading(true); setError(null);
    try {
      const [s, l] = await Promise.all([getShipment(shipmentId), getShipmentLines(shipmentId)]);
      setShipment(s); setLines(l);
      setForm({
        vessel: s.vessel || "", booking_date: s.booking_date || "", actual_etd: s.actual_etd || "", actual_eta: s.actual_eta || "",
        destination_port: s.destination_port || "", consignee_name: s.consignee_name || "", invoice_number: s.invoice_number || "",
        invoice_date: s.invoice_date || "", invoice_value: s.invoice_value ?? "",
      });
    } catch (e) { setError(e.message); }
    setLoading(false);
  }
  useEffect(() => { refresh(); }, [shipmentId]);

  async function saveHeader() {
    setSaving(true); setError(null);
    try {
      const payload = sanitizeHeaderPayload(form);
      if (isNew) {
        const newId = await createShipment(payload);
        navigate(`/shipping/${newId}`, { replace: true });
      } else {
        await updateShipment(shipmentId, payload);
        await refresh();
      }
    } catch (e) { setError(e.message); }
    setSaving(false);
  }
  // Called by AddLinePanel the moment the user selects their first PO on
  // a still-new shipment -- the shipment now genuinely exists, so the URL
  // updates to reflect it without the user having clicked Save first.
  function handleShipmentCreated(newId) { navigate(`/shipping/${newId}`, { replace: true }); }

  async function toggleLock() {
    setSaving(true); setError(null);
    try {
      if (locked) { await unlockShipment(shipmentId, unlockReason); setShowUnlock(false); setUnlockReason(""); }
      else await lockShipment(shipmentId);
      await refresh();
    } catch (e) { setError(e.message); }
    setSaving(false);
  }
  async function removeLine(lineId) {
    if (!window.confirm("Remove this shipment line?")) return;
    try { await deleteShipmentLine(lineId); await refresh(); }
    catch (e) { setError(e.message); }
  }

  if (loading) return <p>Loading...</p>;
  const locked = !isNew && !!shipment?.locked_at && (!shipment.unlocked_at || new Date(shipment.unlocked_at).getTime() + 24 * 3600 * 1000 <= Date.now());
  const withinUnlockWindow = !isNew && !!shipment?.locked_at && shipment.unlocked_at && new Date(shipment.unlocked_at).getTime() + 24 * 3600 * 1000 > Date.now();
  const unlockedUntil = shipment?.unlocked_at ? new Date(new Date(shipment.unlocked_at).getTime() + 24 * 3600 * 1000) : null;
  const totalShipped = lines.reduce((s, l) => s + l.shipped_qty, 0);
  const totalValue = lines.reduce((s, l) => s + (l.shipment_value || 0), 0);
  const invoiceValue = form.invoice_value !== "" ? Number(form.invoice_value) : null;
  const valueDiff = invoiceValue != null ? Math.round((invoiceValue - totalValue) * 100) / 100 : null;

  return (
    <div>
      <button className="btn-ghost-sm" onClick={() => navigate("/shipping")} style={{ marginBottom: 12 }}>← Back to Shipments</button>
      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
      {isNew && <p className="muted-sm" style={{ marginBottom: 10 }}>New shipment — search and select POs below right away, or fill in header details first. Nothing is recorded until you save a header or add a line.</p>}

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <div style={{ fontWeight: 600 }}>Shipment details</div>
          {!isNew && <StatusBadge locked={locked} withinUnlockWindow={withinUnlockWindow} unlockedUntil={unlockedUntil} />}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
          <label className="edit-field">Vessel<input value={form.vessel} disabled={locked} onChange={e => setForm({ ...form, vessel: e.target.value })} /></label>
          <label className="edit-field">Booking Date<input type="date" value={form.booking_date} disabled={locked} onChange={e => setForm({ ...form, booking_date: e.target.value })} /></label>
          <label className="edit-field">Destination Port<input value={form.destination_port} disabled={locked} onChange={e => setForm({ ...form, destination_port: e.target.value })} /></label>
          <label className="edit-field">Actual ETD<input type="date" value={form.actual_etd} disabled={locked} onChange={e => setForm({ ...form, actual_etd: e.target.value })} /></label>
          <label className="edit-field">Actual ETA<input type="date" value={form.actual_eta} disabled={locked} onChange={e => setForm({ ...form, actual_eta: e.target.value })} /></label>
          <label className="edit-field">Consignee<input value={form.consignee_name} disabled={locked} onChange={e => setForm({ ...form, consignee_name: e.target.value })} /></label>
          <label className="edit-field">Invoice Number<input value={form.invoice_number} disabled={locked} onChange={e => setForm({ ...form, invoice_number: e.target.value })} /></label>
          <label className="edit-field">Invoice Date<input type="date" value={form.invoice_date} disabled={locked} onChange={e => setForm({ ...form, invoice_date: e.target.value })} /></label>
          <label className="edit-field">Factory Invoice Value<input type="number" step="0.01" value={form.invoice_value} disabled={locked} onChange={e => setForm({ ...form, invoice_value: e.target.value })} /></label>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          {!locked && <button className="btn-primary" onClick={saveHeader} disabled={saving}>{saving ? "Saving..." : isNew ? "Save Details" : "Save / Edit Shipment"}</button>}
          {!isNew && (!locked
            ? <button className="btn-ghost-sm" onClick={toggleLock} disabled={saving}>Lock Shipment</button>
            : <button className="btn-ghost-sm" style={{ color: "#B91C1C" }} onClick={() => setShowUnlock(true)}>Unlock Shipment (Manager/Admin)</button>)}
        </div>
        {showUnlock && (
          <div style={{ marginTop: 12, padding: 12, background: "#FEF3C7", borderRadius: 8 }}>
            <div className="muted-sm" style={{ marginBottom: 6 }}>Requires Manager/Admin and a reason — opens a 24-hour editing window, after which the shipment automatically locks again.</div>
            <input placeholder="Reason for unlocking" value={unlockReason} onChange={e => setUnlockReason(e.target.value)} style={{ padding: 8, width: "100%", marginBottom: 8 }} />
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn-ghost-sm" onClick={() => setShowUnlock(false)}>Cancel</button>
              <button className="btn-primary" style={{ background: "#B91C1C" }} onClick={toggleLock} disabled={saving || !unlockReason.trim()}>{saving ? "..." : "Confirm Unlock"}</button>
            </div>
          </div>
        )}
        {shipment?.unlock_reason && <p className="muted-sm" style={{ marginTop: 10 }}>Last unlocked by {shipment.profiles?.full_name || "—"}: "{shipment.unlock_reason}"</p>}
      </div>

      {!isNew && (form.invoice_number || totalValue > 0) && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Factory Invoice Summary</div>
          <div style={{ fontSize: 13, lineHeight: 1.8 }}>
            Invoice: {form.invoice_number || "—"}<br />
            Total Shipment Qty: {fmtNum(totalShipped)} pcs<br />
            System Shipment Value: {fmtMoney(totalValue)}<br />
            Factory Invoice Value: {invoiceValue != null ? fmtMoney(invoiceValue) : "not entered yet"}
          </div>
          {invoiceValue != null && (
            Math.abs(valueDiff) < 0.01
              ? <div style={{ marginTop: 8, color: "#15803D", fontWeight: 600 }}>✅ Invoice value matches system value</div>
              : <div style={{ marginTop: 8, color: "#B45309", fontWeight: 600 }}>⚠️ Invoice value does not match system value — System: {fmtMoney(totalValue)}, Invoice: {fmtMoney(invoiceValue)}, Difference: {fmtMoney(Math.abs(valueDiff))}</div>
          )}
        </div>
      )}

      {!isNew && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Lines in this shipment — {fmtNum(totalShipped)} pcs total, {fmtMoney(totalValue)} value</div>
          <table className="data-table">
            <thead><tr><th>PO</th><th>Style</th><th>Color</th><th>Shipped Qty</th><th>Unit Price</th><th>Value</th>{!locked && <th></th>}</tr></thead>
            <tbody>
              {lines.map(l => editingLineId === l.id ? (
                <EditLineRow key={l.id} line={l} onSaved={async () => { setEditingLineId(null); await refresh(); }} onCancel={() => setEditingLineId(null)} />
              ) : (
                <tr key={l.id}>
                  <td className="mono strong">{l.orders?.po_prefix}{l.orders?.po_number}</td>
                  <td className="mono">{l.orders?.style}</td>
                  <td>{l.color_way_name || "—"}</td>
                  <td className="mono">{fmtNum(l.shipped_qty)}</td>
                  <td className="mono">{l.unit_price != null ? fmtMoney(l.unit_price) : "—"}</td>
                  <td className="mono">{l.shipment_value != null ? fmtMoney(l.shipment_value) : "—"}</td>
                  {!locked && <td style={{ display: "flex", gap: 6 }}>
                    <button className="btn-ghost-sm" onClick={() => setEditingLineId(l.id)}>Edit</button>
                    <button className="btn-ghost-sm" style={{ color: "#B91C1C" }} onClick={() => removeLine(l.id)}>Remove</button>
                  </td>}
                </tr>
              ))}
              {lines.length === 0 && <tr><td colSpan={locked ? 6 : 7} className="empty-row">No lines added yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* Available for both a brand-new (unsaved) shipment and an
          existing open one -- confirmed as the real fix: this was
          previously hidden entirely for a new shipment, forcing a
          save-first step nobody wanted. */}
      {!locked && (
        <AddLinePanel shipmentId={shipmentId} isNew={isNew} headerForm={sanitizeHeaderPayload(form)} onShipmentCreated={handleShipmentCreated} onAdded={refresh} />
      )}
    </div>
  );
}

export default function ShippingLanding({ profile }) {
  const { shipmentId } = useParams();

  return (
    <div style={{ padding: 40 }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: "#6B7280" }}>Shipping Portal</div>
        <div style={{ fontSize: 13 }}>Signed in as {profile.full_name}</div>
      </div>
      {shipmentId ? <ShipmentDetail shipmentId={shipmentId} /> : <ShipmentsList />}
    </div>
  );
}
