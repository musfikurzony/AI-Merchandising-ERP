import React from "react";
import { Outlet } from "react-router-dom";
import { factoryCodeOf } from "../../lib/factoryUser.js";

/* The portal now sits INSIDE ErpShell (v96), so the sidebar, header, global
   search and Sign Out all come from there — the same chrome every other
   screen has. What was a bare table on an empty page is now a screen in the
   application.

   This layout is therefore thin on purpose: a title, who you are signed in
   as, and the outlet. Repeating the shell's header here would give the page
   two of everything.

   The old "ERP Modules →" link is not restored as a link, and does not need
   to be: the sidebar has a FACTORY COLLABORATION group alongside whatever
   modules the permission grid grants this account, so moving between the
   portal and the Workbench is one click either way and is visible rather
   than hidden in a corner. */
export default function FactoryPortalLayout({ profile }) {
  const code = factoryCodeOf(profile);
  return (
    <div>
      <div className="fp-head">
        <div>
          <h2 className="fp-title">Factory Collaboration Portal</h2>
          <p className="fp-sub">
            Your purchase orders, grouped by PO. Open a PO to see its styles and colours.
          </p>
        </div>
        {code && (
          <div className="fp-badge">
            <span className="fp-badge-lbl">Signed in for factory</span>
            <span className="fp-badge-code">{code}</span>
          </div>
        )}
      </div>
      <Outlet />
    </div>
  );
}
