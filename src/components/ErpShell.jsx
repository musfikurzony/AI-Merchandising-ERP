import React, { useEffect, useState } from "react";
import { NavLink, Link, Outlet, useLocation } from "react-router-dom";
import { hasModulePermission, ROLE_LANDING_ROUTE } from "../lib/permissions.js";
import { DATE_FORMAT_OPTIONS } from "../lib/dateFormat.js";

/* Grouping and labels exactly as specified. Administration is deliberately
   NOT included here -- it stays separately protected via /admin, its own
   layout, its own guard. */
const NAV_GROUPS = [
  {
    label: "OPERATIONS",
    items: [
      { path: "/dashboard", label: "Dashboard" },
      { path: "/workbench", label: "Daily Workbench" },
      { path: "/orders", label: "Orders" },
      { path: "/follow-up", label: "Follow-up Report" },
      { path: "/crd-monitoring", label: "CRD Change Monitoring" },
      { path: "/plm-import", label: "PLM / Licensee Import" },
      { path: "/backup-export", label: "Backup & Export" },
    ],
  },
  {
    label: "MANAGEMENT",
    items: [
      { path: "/executive-dashboard", label: "Executive Dashboard" },
      { path: "/kpi-dashboard", label: "KPI Dashboard" },
      { path: "/reports", label: "Reports Center" },
    ],
  },
  {
    label: "AI ASSISTANT",
    items: [{ path: "/ai-assistant", label: "AI Assistant" }],
  },
];

const ALL_ITEMS = NAV_GROUPS.flatMap(g => g.items);

export default function ErpShell({ profile, signOut }) {
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
    hasModulePermission("administration", "view").then(result => { if (!cancelled) setCanSeeAdmin(result); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "-apple-system, Segoe UI, Roboto, sans-serif" }}>
      {/* Sidebar */}
      <aside style={{ width: 240, background: "#101B30", color: "#fff", display: "flex", flexDirection: "column", flexShrink: 0 }}>
        <Link to={ROLE_LANDING_ROUTE[profile.role] || "/dashboard"} style={{ padding: "20px 20px 16px", borderBottom: "1px solid rgba(255,255,255,0.08)", display: "block", textDecoration: "none", color: "inherit" }} title="Go to home">
          <div style={{ fontWeight: 700, fontSize: 15 }}>AI Merchandising ERP</div>
          <div style={{ fontSize: 11.5, color: "#9AA5B8", marginTop: 2 }}>PERRY ELLIS INTERNATIONAL – Bangladesh</div>
        </Link>
        <nav style={{ flex: 1, overflowY: "auto", padding: "12px 0" }}>
          {NAV_GROUPS.map(group => (
            <div key={group.label} style={{ marginBottom: 18 }}>
              <div style={{ padding: "0 20px 6px", fontSize: 10.5, letterSpacing: 0.6, color: "#6B7A96", fontWeight: 600 }}>
                {group.label}
              </div>
              {group.items.map(item => (
                <NavLink key={item.path} to={item.path}
                  style={({ isActive }) => ({
                    display: "block", padding: "9px 20px", fontSize: 13.5, textDecoration: "none",
                    color: isActive ? "#fff" : "#C4CCDB",
                    background: isActive ? "rgba(255,255,255,0.08)" : "transparent",
                    borderLeft: isActive ? "3px solid #2B6E6A" : "3px solid transparent",
                  })}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {/* Main column */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Header */}
        <header style={{
          height: 60, background: "#fff", borderBottom: "1px solid #E5E7EB",
          display: "flex", alignItems: "center", padding: "0 24px", gap: 20, flexShrink: 0,
        }}>
          <h1 style={{ fontSize: 16, fontWeight: 600, margin: 0, flexShrink: 0 }}>{currentTitle}</h1>
          {/* Search placeholder -- deliberately non-functional, not wired to
              anything, so it never pretends to search real data it can't
              yet search. */}
          <input placeholder="Search..." disabled
            style={{ flex: 1, maxWidth: 360, padding: "7px 12px", border: "1px solid #E5E7EB", borderRadius: 6, background: "#F9FAFB", color: "#9CA3AF", fontSize: 13 }} />
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 16 }}>
            <select value={dateFormat} onChange={e => setDateFormat(e.target.value)}
              style={{ fontSize: 12, padding: "5px 8px", border: "1px solid #E5E7EB", borderRadius: 6, color: "#4B5563" }}
              title="Date format">
              {DATE_FORMAT_OPTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            {canSeeAdmin && (
              <Link to="/admin" style={{ fontSize: 12.5, color: "#2B6E6A", textDecoration: "none", fontWeight: 600 }}>
                Administration
              </Link>
            )}
            {/* Notification placeholder -- same reasoning: a bell with no
                real feed behind it yet would be a fake control. */}
            <span title="Notifications (not yet wired up)" style={{ fontSize: 18, color: "#9CA3AF", cursor: "default" }}>🔔</span>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{profile.full_name}</div>
              <div style={{ fontSize: 11, color: "#6B7280" }}>{profile.role_label || profile.role}</div>
            </div>
            <button onClick={signOut} style={{ padding: "6px 12px", fontSize: 12.5, border: "1px solid #E5E7EB", borderRadius: 6, background: "#fff", cursor: "pointer" }}>
              Sign Out
            </button>
          </div>
        </header>

        {/* Page content */}
        <main style={{ flex: 1, overflowY: "auto", background: "#F5F6F8" }}>
          <Outlet context={{ dateFormat }} />
        </main>
      </div>
    </div>
  );
}
