import React, { useEffect, useState } from "react";
import { getAlertBadge } from "../lib/aiAssistantApi.js";
import { NavLink, Link, Outlet, useLocation } from "react-router-dom";
import { hasModulePermission, ROLE_LANDING_ROUTE } from "../lib/permissions.js";
import { DATE_FORMAT_OPTIONS } from "../lib/dateFormat.js";
import ErrorBoundary from "./ErrorBoundary.jsx";
import GlobalSearch from "./GlobalSearch.jsx";

/* Grouping and labels exactly as specified. Administration is deliberately
   NOT included here -- it stays separately protected via /admin, its own
   layout, its own guard. */
const NAV_GROUPS = [
  {
    label: "REPORTS",
    items: [
      { path: "/executive-dashboard", label: "Executive Dashboard" },
      { path: "/kpi-dashboard", label: "KPI Dashboard" },
      { path: "/reports/on-time", label: "On-time Performance" },
      { path: "/reports", label: "Reports Center", exact: true },
    ],
  },
  {
    label: "OPERATIONS",
    items: [
      { path: "/dashboard", label: "Dashboard" },
      { path: "/workbench", label: "Daily Workbench" },
      { path: "/orders", label: "Orders" },
      { path: "/follow-up", label: "Follow-up Report" },
      { path: "/crd-monitoring", label: "CRD Change Monitoring" },
      { path: "/shipping", label: "Shipping Portal" },
    ],
  },
  {
    label: "DATA",
    items: [
      { path: "/plm-import", label: "PLM / Licensee Import" },
      { path: "/backup-export", label: "Backup & Export" },
    ],
  },
  {
    label: "AI ASSISTANT",
    items: [{ path: "/ai-assistant", label: "AI Assistant" }],
  },
];

const ALL_ITEMS = NAV_GROUPS.flatMap(g => g.items).concat([{ path: "/factory", label: "Factory Portal" }]);

/* Factory Portal is a role-specific business function, not a module a
   permission toggle turns on/off -- confirmed as the real gap: it was
   never in NAV_GROUPS at all, so a Factory user who got additional ERP
   module permissions (and so could navigate into e.g. /orders) had no way
   back to their own portal except typing the URL from memory. Appending
   this conditionally, rather than folding it into NAV_GROUPS, keeps it
   visually and structurally distinct from ordinary module-permission-gated
   items, matching the requested "FACTORY COLLABORATION" section. */
function visibleGroups(role) {
  const groups = [...NAV_GROUPS];
  if (role === "factory_user" || role === "factory_admin") {
    groups.push({ label: "FACTORY COLLABORATION", items: [{ path: "/factory", label: "Factory Portal" }] });
  }
  return groups;
}

export default function ErpShell({ profile, signOut }) {
  /* The bell is a real number, not decoration: two cheap head-counts
     (past ETD and not shipped, and no factory assigned) refreshed once per
     mount. Its tooltip states exactly what it counts, and it links to the
     AI Assistant where the full set of checks lives. */
  const [alerts, setAlerts] = useState(null);
  useEffect(() => {
    getAlertBadge({ userId: profile?.id, onlyMine: profile?.role === "merchandiser" })
      .then(setAlerts)
      .catch(() => setAlerts(null));
  }, [profile?.id, profile?.role]);

  const location = useLocation();
  const currentTitle = ALL_ITEMS.find(i => location.pathname.startsWith(i.path))?.label || "";

  // Administration deliberately isn't in the sidebar (per Doc 1 -- it's a
  // separately protected module, not part of this menu structure). But
  // since Admin/Super Admin now land on /dashboard like every other role,
  // they need SOME way back into it -- a header link, shown only to
  // whoever actually has access, reusing the same has_module_permission()
  // check RequireModule itself uses, not a hardcoded role list.
  const [canSeeAdmin, setCanSeeAdmin] = useState(false);
  const [dateFormat, setDateFormat] = useState("DDMMYY");
  useEffect(() => {
    let cancelled = false;
    hasModulePermission("administration", "view").then(result => { if (!cancelled) setCanSeeAdmin(result); }).catch(() => { if (!cancelled) setCanSeeAdmin(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "-apple-system, Segoe UI, Roboto, sans-serif" }}>
      {/* Sidebar -- ported from the Shipment Control prototype: brand tile,
          grouped sections with a dot marker that turns amber on the active
          item, and a real "signed in as" footer instead of only a header
          button. Colours come from the CSS token layer in base.css, so the
          palette is defined once for the whole app. */}
      <aside className="pei-side">
        <Link to={ROLE_LANDING_ROUTE[profile.role] || "/dashboard"} className="pei-brand" title="Go to home">
          <span className="pei-brand-tile">PE</span>
          <span>
            <span className="pei-brand-name">AI Merchandising ERP</span>
            <span className="pei-brand-sub" style={{ display: "block" }}>Perry Ellis · Bangladesh</span>
          </span>
        </Link>
        <nav className="pei-nav">
          {visibleGroups(profile.role).map(group => (
            <div className="pei-nav-group" key={group.label}>
              <div className="pei-nav-label">{group.label}</div>
              {group.items.map(item => (
                <NavLink key={item.path} to={item.path} end={!!item.exact}
                  className={({ isActive }) => "pei-nav-item" + (isActive ? " active" : "")}>
                  <span className="dot" />{item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="pei-side-foot">
          <div className="k">SIGNED IN AS</div>
          <div className="n">{profile.full_name}</div>
          <div className="e">{profile.role_label || profile.role}</div>
          <div style={{ display: "flex", gap: 8, marginTop: 11 }}>
            {canSeeAdmin && <Link to="/admin" className="pei-side-btn" style={{ textDecoration: "none" }}>Administration</Link>}
            <button className="pei-side-btn" onClick={signOut}>Sign out</button>
          </div>
          {/* Requested credit line, kept in the one place it appears on
              every screen rather than repeated per page. */}
          <div className="pei-credit">Developed by Musfikur Rahman<br />Copyright © {new Date().getFullYear()}</div>
        </div>
      </aside>

      {/* Main column */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <header style={{
          height: 58, background: "var(--pei-surface)", borderBottom: "1px solid var(--pei-border)",
          display: "flex", alignItems: "center", padding: "0 26px", gap: 18, flexShrink: 0,
        }}>
          <h1 style={{ fontSize: 15.5, fontWeight: 650, margin: 0, flexShrink: 0 }}>{currentTitle}</h1>
          <GlobalSearch dateFormat={dateFormat} />
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14 }}>
            <select value={dateFormat} onChange={e => setDateFormat(e.target.value)}
              style={{ fontSize: 12, padding: "6px 9px", border: "1px solid var(--pei-border)", borderRadius: 8, color: "var(--pei-ink-2)", background: "var(--pei-surface)" }}
              title="Date format">
              {DATE_FORMAT_OPTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <Link to="/ai-assistant" title={alerts ? alerts.title : "Open the AI Assistant"}
              style={{ position: "relative", fontSize: 16, textDecoration: "none", lineHeight: 1, color: "var(--pei-ink-2)" }}>
              🔔
              {alerts && alerts.total > 0 && (
                <span style={{
                  position: "absolute", top: -6, right: -9, background: "var(--band-late)", color: "#fff",
                  borderRadius: 10, fontSize: 9.5, fontWeight: 800, padding: "1px 5px", minWidth: 14, textAlign: "center",
                }}>{alerts.total > 99 ? "99+" : alerts.total}</span>
              )}
            </Link>
            <span className="rc-badge neutral">{profile.role_label || profile.role}</span>
          </div>
        </header>

        {/* Page content */}
        <main style={{ flex: 1, overflowY: "auto", background: "var(--pei-page)" }}>
          <ErrorBoundary key={location.pathname}>
            <Outlet context={{ dateFormat, profile }} />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
