import React from "react";
import { NavLink, Link, Outlet } from "react-router-dom";

const TABS = [
  { to: "/admin/users", label: "Users" },
  { to: "/admin/roles", label: "Roles & Permissions" },
  { to: "/admin/settings", label: "Organization & System Settings" },
  { to: "/admin/audit", label: "Audit Trail" },
];

export default function AdminLayout({ homeTo }) {
  return (
    <div style={{ padding: 24 }}>
      <Link to={homeTo || "/dashboard"} style={{ fontSize: 12.5, color: "#6B7280", textDecoration: "none" }}>← Home</Link>
      <h1 style={{ marginTop: 8 }}>Administration</h1>
      <nav style={{ display: "flex", gap: 6, borderBottom: "1px solid #E2E5EA", marginBottom: 20 }}>
        {TABS.map(t => (
          <NavLink key={t.to} to={t.to}
            style={({ isActive }) => ({
              padding: "10px 16px", textDecoration: "none", color: isActive ? "#2B6E6A" : "#6B7280",
              borderBottom: isActive ? "2px solid #2B6E6A" : "2px solid transparent", fontWeight: isActive ? 600 : 400,
            })}>
            {t.label}
          </NavLink>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
