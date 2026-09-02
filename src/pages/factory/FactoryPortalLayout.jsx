import React from "react";
import { Link, Outlet } from "react-router-dom";

// Deliberately minimal -- per Doc 2, the Factory Portal is one screen
// (My Orders), not a multi-tab nav like Administration. Future items
// (Booking, Documents) are explicitly reserved, not stubbed here.
//
// The one addition: a link into the ERP-wrapped experience, for a Factory
// user who's also been granted additional module permissions (Orders
// view, etc.) -- confirmed as a real gap, since this layout previously had
// no way there at all except typing a URL. Harmless even for a Factory
// user with no extra permissions: RequireModule correctly redirects them
// straight back here.
export default function FactoryPortalLayout() {
  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
        <h1 style={{ margin: 0 }}>Factory Collaboration Portal</h1>
        <Link to="/dashboard" style={{ fontSize: 12.5, color: "#2B6E6A" }}>ERP Modules →</Link>
      </div>
      <Outlet />
    </div>
  );
}
