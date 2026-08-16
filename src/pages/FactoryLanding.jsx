import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";

export default function FactoryLanding({ profile }) {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Deliberately the factory_portal_orders VIEW, never the orders table
    // directly -- this is the actual security boundary (column + row
    // restriction), same as the real Factory Portal (Phase 3) will use.
    supabase.from("factory_portal_orders").select("po, etd, ordered_qty, status, current_crd")
      .then(({ data, error }) => { if (error) setError(error.message); else setOrders(data); });
  }, []);

  return (
    <div style={{ padding: 40 }}>
      <h2>Welcome, {profile.full_name}</h2>
      <p style={{ color: "#6B7280" }}>Factory Collaboration Portal — minimal landing screen for this round; full "My Orders" with multi-select CRD submission is Phase 3.</p>
      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
      {orders && (
        <table className="data-table" style={{ marginTop: 20, maxWidth: 600 }}>
          <thead><tr><th>PO</th><th>ETD</th><th>Qty</th><th>Status</th><th>Current CRD</th></tr></thead>
          <tbody>
            {orders.map(o => (
              <tr key={o.po}><td>{o.po}</td><td>{o.etd}</td><td>{o.ordered_qty}</td><td>{o.status}</td><td>{o.current_crd || "—"}</td></tr>
            ))}
            {orders.length === 0 && <tr><td colSpan={5}>No orders assigned to your factory yet.</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  );
}
