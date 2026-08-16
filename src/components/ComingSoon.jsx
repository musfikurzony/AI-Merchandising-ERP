import React from "react";

/* Honest placeholder for Phase 4 modules not yet built -- never fake
   functionality or fabricated data, per explicit instruction. Takes the
   exact title/subtitle so each nav item's placeholder reads specifically,
   not generically. */
export default function ComingSoon({ title, subtitle }) {
  return (
    <div style={{ padding: 40 }}>
      <h2 style={{ marginBottom: 4 }}>{title}</h2>
      <p style={{ color: "#6B7280", fontSize: 14 }}>Coming in Phase 4{subtitle ? ` — ${subtitle}` : ""}</p>
    </div>
  );
}
