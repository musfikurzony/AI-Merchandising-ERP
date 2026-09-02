/* RETIRED in v86 — not imported by any route.
   Replaced by src/pages/dashboard/, where one role-aware Dashboard does what
   these three landing screens did separately. Kept in the tree for one release
   so the change can be reverted quickly if the new screen surprises anyone in
   live use; delete after that. Do not add features here.

   Two reasons it was replaced, both worth remembering: this file defined its
   own alert thresholds (a fourth rule set beside the notification engine), and
   its KPI query had no .range(), so it silently truncated at PostgREST's
   1,000-row ceiling. */

import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient.js";
import { getMyOrders, getOrdersNeedingFactory, getOrdersWithCrdAttention, getExFactoryMilestonesForOrders } from "../lib/ordersApi.js";
import { buildReportDataset, computeOpenOrders, computeShippedOrders, orderMetrics } from "../lib/reportsApi.js";

// Real Dashboard content: risk-based KPI cards, Today's Actions (two real
// categories -- factory assignment and CRD attention; a third
// (T&A/critical-path alerts) is deliberately absent until Milestone 5's
// structured T&A table exists, rather than faking it), and a clickable
// My Orders table. Every number here comes from a real query -- nothing
// fabricated, exactly as instructed.
//
// "My Orders" and the Factory-Assignment/CRD-Attention panels are
// merchandiser-workflow concepts -- confirmed as a real gap for Shipping,
// whose role doesn't map to "my" orders at all (they're not a primary
// merchandiser on anything). Shipping gets a company-wide operational
// panel instead, reusing the exact same computeOpenOrders/
// computeShippedOrders functions Reports Center already uses and tests --
// not a second implementation of the same numbers.
function ShippingOverview() {
  const [data, setData] = useState(null);
  const [exFactoryByOrder, setExFactoryByOrder] = useState(new Map());
  const [error, setError] = useState(null);

  useEffect(() => {
    buildReportDataset({}).then(async result => {
      setData(result);
      const ex = await getExFactoryMilestonesForOrders(result.orders.map(o => o.id));
      setExFactoryByOrder(ex);
    }).catch(e => setError(e.message));
  }, []);

  if (error) return <p style={{ color: "#B91C1C" }}>{error}</p>;
  if (!data) return <p style={{ color: "#6B7280" }}>Loading...</p>;

  const open = computeOpenOrders(data.orders, data.shipmentSummaryByOrder);
  const shipped = computeShippedOrders(data.orders, data.shipmentSummaryByOrder);

  // "Shipped" (orders.status='shipped', Ex-Factory Done) splits into two
  // real buckets using data buildReportDataset() already fetched -- no
  // new query. lineCount > 0 means Shipping has actually entered real
  // shipment_lines for it; lineCount 0 means Ex-Factory completed but
  // Shipping hasn't started yet.
  const readyForShipping = shipped.rows.filter(o => !(data.shipmentSummaryByOrder.get(o.id)?.lineCount > 0));
  const inProgress = shipped.rows.filter(o => data.shipmentSummaryByOrder.get(o.id)?.lineCount > 0);

  // Overdue/attention: Ex-Factory completed 7+ days ago with still zero
  // shipment lines -- a real, data-driven staleness signal, not a guess.
  const today = new Date();
  const overdue = readyForShipping.filter(o => {
    const actual = exFactoryByOrder.get(o.id)?.actual_date;
    if (!actual) return false;
    return Math.round((today - new Date(actual)) / 86400000) >= 7;
  });

  // Recently Ex-Factory-completed, newest first -- the "notification"
  // list. Purely data-driven: reads the same order_milestones row every
  // other Ex-Factory screen reads, sorted by when it was actually saved.
  const recentExFactory = [...exFactoryByOrder.entries()]
    .filter(([, m]) => m.status === "done")
    .sort((a, b) => new Date(b[1].updated_at) - new Date(a[1].updated_at))
    .slice(0, 8)
    .map(([orderId, m]) => ({ order: data.orders.find(o => o.id === orderId), milestone: m }))
    .filter(r => r.order);

  // Next-step guidance -- data-driven against actual missing fields, not
  // hardcoded text. Checks the real shipment header(s) tied to each
  // order's lines for what's still blank.
  function nextStepFor(order) {
    const summary = data.shipmentSummaryByOrder.get(order.id);
    if (!summary?.lineCount) return "Shipment information needs to be completed.";
    const lines = data.shipmentLines.filter(l => l.order_id === order.id);
    const missingInvoice = lines.some(l => !l.shipments?.actual_etd);
    if (missingInvoice) return "Actual ETD still pending.";
    const missingEta = lines.some(l => !l.shipments?.actual_eta);
    if (missingEta) return "ETA still pending.";
    return null;
  }
  const guidance = shipped.rows.map(o => ({ order: o, next: nextStepFor(o) })).filter(g => g.next).slice(0, 6);

  const cards = [
    { label: "Open Orders", value: open.poCount, sub: `${open.qty.toLocaleString()} pcs · $${Math.round(open.value).toLocaleString()}`, color: "#1A2233" },
    { label: "Shipped Orders", value: shipped.poCount, sub: `${shipped.qty.toLocaleString()} pcs · $${Math.round(shipped.value).toLocaleString()}`, color: "#15803D" },
    { label: "Ready for Shipping", value: readyForShipping.length, sub: "Ex-Factory Done, no shipment yet", color: "#B45309" },
    { label: "Shipments in Progress", value: inProgress.length, sub: "Shipment data being entered", color: "#1D4ED8" },
    { label: "Overdue / Attention", value: overdue.length, sub: "Ex-Factory 7+ days, no shipment yet", color: "#B91C1C" },
  ];

  return (
    <div>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 28 }}>
        {cards.map(c => (
          <div key={c.label} style={{ padding: 20, background: "#fff", borderRadius: 10, minWidth: 170, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
            <div style={{ fontSize: 26, fontWeight: 700, color: c.color }}>{c.value}</div>
            <div style={{ color: "#1F2937", fontSize: 13, fontWeight: 600 }}>{c.label}</div>
            <div style={{ color: "#9CA3AF", fontSize: 11.5, marginTop: 2 }}>{c.sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 28 }}>
        <div style={{ background: "#fff", padding: 20, borderRadius: 10 }}>
          <h3 style={{ marginTop: 0 }}>🔔 Recently Ex-Factory — Ready for Shipping</h3>
          {recentExFactory.length === 0 && <p style={{ color: "#6B7280", fontSize: 13 }}>Nothing recently completed.</p>}
          {recentExFactory.map(({ order: o, milestone: m }) => (
            <div key={o.id} style={{ padding: "10px 0", borderBottom: "1px solid #F2F3F6", fontSize: 13 }}>
              <Link to={`/orders/${o.id}`} style={{ color: "#2B6E6A", fontWeight: 600, textDecoration: "none" }}>{o.po_prefix}{o.po_number}</Link>
              {" "}· {o.style} · {o.factories?.name || "—"} · {o.customers?.name || "—"} · {o.qty} pcs
              <div style={{ color: "#9CA3AF", fontSize: 11.5 }}>Ex-Factory completed {m.actual_date} · ETD {o.etd}</div>
            </div>
          ))}
        </div>

        <div style={{ background: "#fff", padding: 20, borderRadius: 10 }}>
          <h3 style={{ marginTop: 0 }}>💡 Shipping Assistant — Next Actions</h3>
          {guidance.length === 0 && <p style={{ color: "#6B7280", fontSize: 13 }}>No pending actions right now.</p>}
          {guidance.map(g => (
            <div key={g.order.id} style={{ padding: "10px 0", borderBottom: "1px solid #F2F3F6", fontSize: 13 }}>
              <Link to={`/orders/${g.order.id}`} style={{ color: "#2B6E6A", fontWeight: 600, textDecoration: "none" }}>{g.order.po_prefix}{g.order.po_number}</Link>
              <div style={{ color: "#B45309", fontSize: 12.5 }}>👉 {g.next}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ background: "#fff", padding: 20, borderRadius: 10 }}>
        <h3 style={{ marginTop: 0 }}>Company-wide Open Orders</h3>
        {data.shipmentLines.length === 0 && <p style={{ color: "#9CA3AF", fontSize: 12.5, marginBottom: 10 }}>No shipment transactions recorded yet.</p>}
        <table className="data-table">
          <thead><tr><th>PO</th><th>Style</th><th>Customer</th><th>Factory</th><th>ETD</th><th>Ordered</th><th>Shipped</th><th>Balance</th></tr></thead>
          <tbody>
            {open.rows.slice(0, 15).map(o => {
              const m = orderMetrics(o, data.shipmentSummaryByOrder);
              return (
                <tr key={o.id}>
                  <td><Link to={`/orders/${o.id}`} style={{ color: "#2B6E6A", fontWeight: 600, textDecoration: "none" }}>{o.po_prefix}{o.po_number}</Link></td>
                  <td>{o.style}</td><td>{o.customers?.name || "—"}</td><td>{o.factories?.name || "—"}</td><td>{o.etd}</td>
                  <td>{m.orderedQty}</td><td>{m.shippedQty}</td><td>{m.balanceQty}</td>
                </tr>
              );
            })}
            {open.rows.length === 0 && <tr><td colSpan={8}>No open orders.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function DashboardLanding({ profile }) {
  const [stats, setStats] = useState(null);
  const [needsFactory, setNeedsFactory] = useState([]);
  const [crdAttention, setCrdAttention] = useState([]);
  const [myOrders, setMyOrders] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    supabase.from("orders").select("id, status, risk")
      .then(({ data, error }) => {
        if (error) { setError(error.message); return; }
        setStats({
          active: data.filter(o => o.status !== "shipped" && o.status !== "cancelled").length,
          critical: data.filter(o => o.risk === "critical").length,
          atRisk: data.filter(o => o.risk === "atRisk").length,
          onTrack: data.filter(o => o.risk === "onTrack").length,
        });
      });
    getOrdersNeedingFactory().then(setNeedsFactory).catch(e => setError(e.message));
    getOrdersWithCrdAttention().then(setCrdAttention).catch(e => setError(e.message));
    getMyOrders().then(setMyOrders).catch(e => setError(e.message));
  }, []);

  const cards = stats ? [
    { label: "Active Orders", value: stats.active, color: "#1A2233" },
    { label: "Critical", value: stats.critical, color: "#B91C1C" },
    { label: "At Risk", value: stats.atRisk, color: "#B45309" },
    { label: "On Track", value: stats.onTrack, color: "#15803D" },
  ] : [];

  return (
    <div style={{ padding: 32 }}>
      <h2 style={{ marginTop: 0, marginBottom: 4 }}>Welcome, {profile.full_name}</h2>
      <p style={{ color: "#6B7280", fontSize: 13, marginBottom: 24 }}>Here's what needs attention today.</p>
      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}

      {stats && (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 28 }}>
          {cards.map(c => (
            <div key={c.label} style={{ padding: 20, background: "#fff", borderRadius: 10, minWidth: 160, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
              <div style={{ fontSize: 28, fontWeight: 700, color: c.color }}>{c.value}</div>
              <div style={{ color: "#6B7280", fontSize: 13 }}>{c.label}</div>
            </div>
          ))}
        </div>
      )}

      {profile.role === "shipping" ? (
        <ShippingOverview />
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 28 }}>
            <div style={{ background: "#fff", padding: 20, borderRadius: 10 }}>
              <h3 style={{ marginTop: 0 }}>Today's Actions — Factory Assignment</h3>
              {needsFactory.length === 0 ? <p style={{ color: "#6B7280", fontSize: 13 }}>Nothing needs factory assignment.</p> : (
                <table className="data-table">
                  <thead><tr><th>PO</th><th>Style</th><th>Customer</th><th>ETD</th></tr></thead>
                  <tbody>
                    {needsFactory.map(o => (
                      <tr key={o.id}>
                        <td><Link to={`/orders/${o.id}`}>{o.po_prefix}{o.po_number}</Link></td>
                        <td>{o.style}</td><td>{o.customers?.name || "—"}</td><td>{o.etd}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div style={{ background: "#fff", padding: 20, borderRadius: 10 }}>
              <h3 style={{ marginTop: 0 }}>Today's Actions — CRD Attention</h3>
              {crdAttention.length === 0 ? <p style={{ color: "#6B7280", fontSize: 13 }}>No orders with critical or warning CRD status.</p> : (
                <table className="data-table">
                  <thead><tr><th>PO</th><th>Classification</th><th>New CRD</th></tr></thead>
                  <tbody>
                    {crdAttention.map(c => (
                      <tr key={c.order_id}>
                        <td><Link to={`/orders/${c.order_id}`}>{c.orders?.po_prefix}{c.orders?.po_number}</Link></td>
                        <td style={{ color: c.classification === "critical" ? "#B91C1C" : "#B45309" }}>{c.classification}</td>
                        <td>{c.new_crd}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p style={{ fontSize: 11.5, color: "#9CA3AF", marginTop: 10 }}>
                T&A / critical-path alerts will appear here once the structured T&A engine (Milestone 5) exists.
              </p>
            </div>
          </div>

          <div style={{ background: "#fff", padding: 20, borderRadius: 10 }}>
            <h3 style={{ marginTop: 0 }}>My Orders</h3>
            <table className="data-table">
              <thead><tr><th>PO</th><th>Style</th><th>Label</th><th>Division</th><th>Qty</th><th>ETD</th><th>Status</th><th>Risk</th></tr></thead>
              <tbody>
                {myOrders.map(o => (
                  <tr key={o.id}>
                    <td><Link to={`/orders/${o.id}`} style={{ color: "#2B6E6A", fontWeight: 600, textDecoration: "none" }}>{o.po_prefix}{o.po_number}</Link></td>
                    <td>{o.style}</td><td>{o.labels?.name || "—"}</td><td>{o.divisions?.name || "—"}</td>
                    <td>{o.qty}</td><td>{o.etd}</td><td>{o.status}</td><td>{o.risk}</td>
                  </tr>
                ))}
                {myOrders.length === 0 && <tr><td colSpan={8}>No orders visible.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
