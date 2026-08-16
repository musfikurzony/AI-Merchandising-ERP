import React, { useState } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { useSession } from "./lib/useSession.js";
import { ROLE_LANDING_ROUTE } from "./lib/permissions.js";
import { supabase } from "./lib/supabaseClient.js";
import AdminLayout from "./pages/admin/AdminLayout.jsx";
import UserManagement from "./pages/admin/UserManagement.jsx";
import RoleManagement from "./pages/admin/RoleManagement.jsx";
import OrganizationSettings from "./pages/admin/OrganizationSettings.jsx";
import AuditTrail from "./pages/admin/AuditTrail.jsx";
import DashboardLanding from "./pages/DashboardLanding.jsx";
import ExecutiveLanding from "./pages/ExecutiveLanding.jsx";
import FactoryPortalLayout from "./pages/factory/FactoryPortalLayout.jsx";
import FactoryMyOrders from "./pages/factory/FactoryMyOrders.jsx";
import OrdersList from "./pages/orders/OrdersList.jsx";
import OrderDetail from "./pages/orders/OrderDetail.jsx";
import PlmImportCenter from "./pages/plm-import/PlmImportCenter.jsx";
import Workbench from "./pages/workbench/Workbench.jsx";
import FollowUpReport from "./pages/follow-up/FollowUpReport.jsx";
import CrdChangeMonitoring from "./pages/crd-monitoring/CrdChangeMonitoring.jsx";
import KpiDashboard from "./pages/kpi-dashboard/KpiDashboard.jsx";
import ShippingLanding from "./pages/ShippingLanding.jsx";
import RequireModule from "./components/RequireModule.jsx";
import ErpShell from "./components/ErpShell.jsx";
import ComingSoon from "./components/ComingSoon.jsx";

function LoginScreen({ signIn }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true); setError(null);
    const { error } = await signIn(email, password);
    setBusy(false);
    if (error) setError(error.message);
  }

  return (
    <div style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center" }}>
      <form onSubmit={handleSubmit} style={{ width: 340, padding: 32, background: "#fff", borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.08)" }}>
        <h2 style={{ marginTop: 0, marginBottom: 2 }}>AI Merchandising ERP</h2>
        <p style={{ marginTop: 0, marginBottom: 20, color: "#6B7280", fontSize: 13 }}>
          PERRY ELLIS INTERNATIONAL – Bangladesh
        </p>
        {/* Static, deliberately -- organization_settings already holds this
            same text, but its RLS correctly requires an authenticated
            session to read, and this screen runs before login. Making this
            dynamic would need a deliberate anon-read policy decision, not
            assumed here. */}
        <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)}
          style={{ width: "100%", padding: 10, marginBottom: 10, boxSizing: "border-box" }} />
        <input type="password" placeholder="Password" value={password} onChange={e => setPassword(e.target.value)}
          style={{ width: "100%", padding: 10, marginBottom: 10, boxSizing: "border-box" }} />
        {error && <p style={{ color: "#B91C1C", fontSize: 13 }}>{error}</p>}
        <button type="submit" disabled={busy} style={{ width: "100%", padding: 10, background: "#2B6E6A", color: "#fff", border: "none", borderRadius: 6 }}>
          {busy ? "Signing in..." : "Sign In"}
        </button>
      </form>
    </div>
  );
}

/* Real implementation now (was a stub in the original scaffold). Calls Supabase Auth
   directly to set the new password, then clears must_change_password so
   useSession's next profile load reflects it and the gate in App() below
   opens automatically -- no separate "done" flag to keep in sync. */
function ForcePasswordChange({ userId }) {
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (newPassword.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (newPassword !== confirm) { setError("Passwords don't match."); return; }
    setBusy(true);
    const { error: pwErr } = await supabase.auth.updateUser({ password: newPassword });
    if (pwErr) { setError(pwErr.message); setBusy(false); return; }
    const { error: profErr } = await supabase.from("profiles").update({ must_change_password: false }).eq("id", userId);
    setBusy(false);
    if (profErr) setError(profErr.message);
    // No explicit navigation -- useSession's onAuthStateChange / next
    // profile read picks up must_change_password = false and App() below
    // naturally stops rendering this screen. Reload as a simple fallback
    // in case the session hook doesn't re-fetch automatically:
    window.location.reload();
  }

  return (
    <div style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center" }}>
      <form onSubmit={handleSubmit} style={{ width: 340, padding: 32, background: "#fff", borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.08)" }}>
        <h2 style={{ marginTop: 0 }}>Change Your Password</h2>
        <p style={{ fontSize: 13, color: "#6B7280" }}>Required before continuing -- your account was created or reset with a temporary password.</p>
        <input type="password" placeholder="New password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
          style={{ width: "100%", padding: 10, marginBottom: 10, boxSizing: "border-box" }} />
        <input type="password" placeholder="Confirm new password" value={confirm} onChange={e => setConfirm(e.target.value)}
          style={{ width: "100%", padding: 10, marginBottom: 10, boxSizing: "border-box" }} />
        {error && <p style={{ color: "#B91C1C", fontSize: 13 }}>{error}</p>}
        <button type="submit" disabled={busy} style={{ width: "100%", padding: 10, background: "#2B6E6A", color: "#fff", border: "none", borderRadius: 6 }}>
          {busy ? "Saving..." : "Set Password"}
        </button>
      </form>
    </div>
  );
}

export default function App() {
  const { session, profile, loading, signIn, signOut } = useSession();

  if (loading) return <div style={{ padding: 40 }}>Loading...</div>;
  if (!session) return <LoginScreen signIn={signIn} />;
  if (!profile) return <div style={{ padding: 40 }}>Your account exists but has no profile row -- contact an Administrator.</div>;
  if (!profile.is_active) return <div style={{ padding: 40 }}>Your account is deactivated -- contact an Administrator.</div>;
  if (profile.must_change_password) return <ForcePasswordChange userId={profile.id} />;

  const landing = ROLE_LANDING_ROUTE[profile.role] || "/dashboard";

  // Routes wrapped in ErpShell now have their own header Sign Out button.
  // The original floating button (below) is kept unconditionally rather
  // than adding path-based logic to hide it -- a minor, known, non-blocking
  // cosmetic overlap on shell pages, not a functional issue. /admin,
  // /factory, /shipping are untouched and keep relying on it exactly as
  // before, since those layouts have no header of their own.

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to={landing} replace />} />

        <Route element={<ErpShell profile={profile} signOut={signOut} />}>
          <Route path="/dashboard" element={<DashboardLanding profile={profile} />} />
          <Route path="/workbench" element={<RequireModule module="workbench" fallback={landing}><Workbench /></RequireModule>} />
          <Route path="/orders" element={<RequireModule module="orders" fallback={landing}><OrdersList /></RequireModule>} />
          <Route path="/orders/:id" element={<RequireModule module="orders" fallback={landing}><OrderDetail /></RequireModule>} />
          {/* Follow-up Report reuses the 'crd_monitoring' module key -- the
              closest existing semantic match (Doc: "Merchandising Follow-up
              & Risk Monitoring"); no dedicated key exists and none was
              invented, per instruction. */}
          <Route path="/follow-up" element={<RequireModule module="workbench" fallback={landing}><FollowUpReport /></RequireModule>} />
          <Route path="/crd-monitoring" element={<RequireModule module="crd_monitoring" fallback={landing}><CrdChangeMonitoring /></RequireModule>} />
          {/* No module_permissions key exists yet for PLM Import or Backup/
              Export (confirmed by inspection) -- rather than invent one,
              these two routes are intentionally unguarded placeholders for
              now. Real module_permissions rows (plm_import, backup_export)
              will be proposed before Milestones 3 and 11 respectively, when
              there's real functionality behind them worth protecting. */}
          <Route path="/plm-import" element={<RequireModule module="plm_import" fallback={landing}><PlmImportCenter /></RequireModule>} />
          <Route path="/backup-export" element={<ComingSoon title="Backup & Export" subtitle="Controlled Data Export" />} />
          <Route path="/executive-dashboard" element={<RequireModule module="executive_dashboard" fallback={landing}><ExecutiveLanding profile={profile} /></RequireModule>} />
          <Route path="/kpi-dashboard" element={<RequireModule module="kpi_dashboard" fallback={landing}><KpiDashboard /></RequireModule>} />
          <Route path="/reports" element={<RequireModule module="reports" fallback={landing}><ComingSoon title="Reports Center" subtitle="Professional Reporting" /></RequireModule>} />
          <Route path="/ai-assistant" element={<RequireModule module="ai_assistant" fallback={landing}><ComingSoon title="AI Assistant" subtitle="ERP-Aware Assistant" /></RequireModule>} />
        </Route>

        <Route path="/admin" element={<RequireModule module="administration" fallback={landing}><AdminLayout homeTo={landing} /></RequireModule>}>
          <Route index element={<Navigate to="/admin/users" replace />} />
          <Route path="users" element={<UserManagement />} />
          <Route path="roles" element={<RoleManagement />} />
          <Route path="settings" element={<OrganizationSettings />} />
          <Route path="audit" element={<AuditTrail />} />
        </Route>

        <Route path="/factory" element={<RequireModule module="factory_portal" fallback={landing}><FactoryPortalLayout /></RequireModule>}>
          <Route index element={<FactoryMyOrders />} />
        </Route>
        <Route path="/shipping" element={<RequireModule module="shipping_portal" fallback={landing}><ShippingLanding profile={profile} /></RequireModule>} />
        <Route path="*" element={<Navigate to={landing} replace />} />
      </Routes>
      <button onClick={signOut} style={{ position: "fixed", top: 12, right: 12 }}>Sign Out</button>
    </BrowserRouter>
  );
}
