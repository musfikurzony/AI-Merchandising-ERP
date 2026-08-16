import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient.js";

export default function ShippingLanding({ profile }) {
  const [pendingInvoice, setPendingInvoice] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    supabase.from("orders").select("id", { count: "exact", head: true })
      .eq("status", "shipped").is("invoiced_at", null)
      .then(({ count, error }) => { if (error) setError(error.message); else setPendingInvoice(count); });
  }, []);

  return (
    <div style={{ padding: 40 }}>
      <h2>Welcome, {profile.full_name}</h2>
      <p style={{ color: "#6B7280" }}>Shipping Portal — minimal landing screen for this round; full Shipment Dashboard/Invoice workflow is Phase 4.</p>
      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
      {pendingInvoice !== null && (
        <div style={{ marginTop: 20, padding: 20, background: "#fff", borderRadius: 10, maxWidth: 280 }}>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{pendingInvoice}</div>
          <div style={{ color: "#6B7280", fontSize: 13 }}>orders pending invoice</div>
        </div>
      )}
    </div>
  );
}
