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
