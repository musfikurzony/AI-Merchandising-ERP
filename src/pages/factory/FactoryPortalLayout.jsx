import React from "react";
import { Outlet } from "react-router-dom";

// Deliberately minimal -- per Doc 2, the Factory Portal is one screen
// (My Orders), not a multi-tab nav like Administration. Future items
// (Booking, Documents) are explicitly reserved, not stubbed here.
export default function FactoryPortalLayout() {
  return (
    <div style={{ padding: 24 }}>
      <h1 style={{ marginTop: 0 }}>Factory Collaboration Portal</h1>
      <Outlet />
    </div>
  );
}
