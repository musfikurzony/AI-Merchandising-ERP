import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { supabase } from "../lib/supabaseClient.js";
import { getMyOrders, getOrdersNeedingFactory, getOrdersWithCrdAttention } from "../lib/ordersApi.js";

// Real Dashboard content: risk-based KPI cards, Today's Actions (two real
// categories -- factory assignment and CRD attention; a third
// (T&A/critical-path alerts) is deliberately absent until Milestone 5's
// structured T&A table exists, rather than faking it), and a clickable
// My Orders table. Every number here comes from a real query -- nothing
// fabricated, exactly as instructed.
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
    </div>
  );
}
