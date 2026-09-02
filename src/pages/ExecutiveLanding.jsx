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

export default function ExecutiveLanding({ profile }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    supabase.from("orders").select("id, qty, fob, status")
      .then(({ data, error }) => {
        if (error) { setError(error.message); return; }
        const open = data.filter(o => o.status !== "shipped" && o.status !== "cancelled").length;
        const totalValue = data.reduce((s, o) => s + (o.qty || 0) * (o.fob || 0), 0);
        setStats({ total: data.length, open, totalValue });
      });
  }, []);

  return (
    <div style={{ padding: 40 }}>
      <h2>Welcome, {profile.full_name}</h2>
      <p style={{ color: "#6B7280" }}>Executive Dashboard — minimal landing screen for this round; the full KPI/Reports Center experience is separate scope.</p>
      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
      {stats && (
        <div style={{ display: "flex", gap: 16, marginTop: 20 }}>
          <div style={{ padding: 20, background: "#fff", borderRadius: 10, minWidth: 160 }}>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{stats.total}</div>
            <div style={{ color: "#6B7280", fontSize: 13 }}>total orders</div>
          </div>
          <div style={{ padding: 20, background: "#fff", borderRadius: 10, minWidth: 160 }}>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{stats.open}</div>
            <div style={{ color: "#6B7280", fontSize: 13 }}>open orders</div>
          </div>
          <div style={{ padding: 20, background: "#fff", borderRadius: 10, minWidth: 160 }}>
            <div style={{ fontSize: 28, fontWeight: 700 }}>${stats.totalValue.toLocaleString()}</div>
            <div style={{ color: "#6B7280", fontSize: 13 }}>total FOB value</div>
          </div>
        </div>
      )}
    </div>
  );
}
