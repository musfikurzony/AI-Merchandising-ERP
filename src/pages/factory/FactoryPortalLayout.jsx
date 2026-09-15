import React from "react";
import { Outlet } from "react-router-dom";
import { factoryCodeOf } from "../../lib/factoryUser.js";

/* One screen, deliberately — per Doc 2 the Factory Portal is My Orders, not
   a multi-tab nav like Administration. Booking and Documents are reserved,
   not stubbed.

   --------------------------------------------------------------------------
   THE "ERP MODULES →" LINK IS GONE, ON PURPOSE
   --------------------------------------------------------------------------
   This layout used to carry a link into the internal ERP, added for "a
   factory user who has also been granted additional module permissions". It
   was reasoned from the permission grid: if they have been granted Orders,
   why not give them a way there.

   That reasoning had the boundary in the wrong place. The people using this
   portal work for a different company. The question is not whether somebody
   ticked a box for them — it is that the internal ERP holds the FOB, the
   real delivery dates and every other factory's order book, and no ticked
   box should be able to put a supplier inside it. App.jsx now refuses to
   build those routes for a factory user at all, so the link would go
   nowhere; removing it also removes the suggestion that there is somewhere
   to go. */
export default function FactoryPortalLayout({ profile }) {
  const code = factoryCodeOf(profile);
  return (
    <div style={{ padding: 24, minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0 }}>Factory Collaboration Portal</h1>
        <p style={{ margin: "2px 0 0", color: "#6B7280", fontSize: 13 }}>
          PERRY ELLIS INTERNATIONAL – Bangladesh
          {code ? <> · signed in for factory <strong>{code}</strong></> : null}
          {profile?.full_name ? <> · {profile.full_name}</> : null}
        </p>
      </div>
      <div style={{ flex: 1 }}><Outlet /></div>
      <div style={{ marginTop: 28, paddingTop: 10, borderTop: "1px solid #E5E7EB", color: "#9CA3AF", fontSize: 11.5, textAlign: "center" }}>
        Developed by Musfikur Rahman | Copyright © {new Date().getFullYear()}
      </div>
    </div>
  );
}
