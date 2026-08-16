import React, { useEffect, useState } from "react";
import { listUsers, createUser, updateUserProfile, resetPassword, forcePasswordChange, setUserActive, deleteUserPermanently, listRoles } from "../../lib/adminApi.js";
import UserOverrides from "./UserOverrides.jsx";
import UserHistory from "./UserHistory.jsx";

const ROLE_FILTER_GROUPS = [
  { label: "All", roles: null },
  { label: "Merchandising", roles: ["merchandiser", "manager", "management", "admin", "super_admin"] },
  { label: "Factory", roles: ["factory_admin", "factory_user"] },
  { label: "Shipping", roles: ["shipping", "commercial"] },
];

function UserForm({ user, roles, onSave, onCancel }) {
  const [form, setForm] = useState(user || {
    email: "", full_name: "", role: "merchandiser", employee_id: "", department: "",
    designation: "", mobile: "", linked_factory_code: "",
  });
  const needsFactory = form.role === "factory_admin" || form.role === "factory_user";
  return (
    <div className="modal-backdrop">
      <div className="modal-box">
        <h3>{user ? `Edit ${user.full_name}` : "Add User"}</h3>
        {!user && (
          <label className="field">Email
            <input value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} />
          </label>
        )}
        {user && (
          <label className="field">Email
            <input value={user.email || "—"} disabled style={{ background: "#F3F4F6", color: "#6B7280" }} />
          </label>
        )}
        <label className="field">Full Name
          <input value={form.full_name} onChange={e => setForm({ ...form, full_name: e.target.value })} />
        </label>
        <label className="field">Role
          <select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}>
            {roles.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </label>
        {needsFactory && (
          <label className="field">Factory Code (e.g. F2396)
            <input value={form.linked_factory_code || ""} onChange={e => setForm({ ...form, linked_factory_code: e.target.value })} />
          </label>
        )}
        <label className="field">Employee ID
          <input value={form.employee_id || ""} onChange={e => setForm({ ...form, employee_id: e.target.value })} />
        </label>
        <label className="field">Department
          <input value={form.department || ""} onChange={e => setForm({ ...form, department: e.target.value })} />
        </label>
        <label className="field">Designation
          <input value={form.designation || ""} onChange={e => setForm({ ...form, designation: e.target.value })} />
        </label>
        <label className="field">Mobile
          <input value={form.mobile || ""} onChange={e => setForm({ ...form, mobile: e.target.value })} />
        </label>
        <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
          <button onClick={onCancel}>Cancel</button>
          <button className="btn-primary" onClick={() => onSave(form)}>Save</button>
        </div>
      </div>
    </div>
  );
}

export default function UserManagement() {
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [filter, setFilter] = useState(ROLE_FILTER_GROUPS[0]);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState(null); // null | {} (new) | user object
  const [overridesUser, setOverridesUser] = useState(null);
  const [historyUser, setHistoryUser] = useState(null);
  const [tempPasswordNotice, setTempPasswordNotice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function refresh() {
    setLoading(true); setError(null);
    const [uResult, rResult] = await Promise.allSettled([listUsers(), listRoles()]);
    if (uResult.status === "fulfilled") setUsers(uResult.value);
    if (rResult.status === "fulfilled") setRoles(rResult.value);
    const failures = [uResult, rResult].filter(r => r.status === "rejected").map(r => r.reason?.message).filter(Boolean);
    if (failures.length) setError(failures.join(" | "));
    setLoading(false);
  }
  useEffect(() => { refresh(); }, []);

  const visible = users.filter(u =>
    (!filter.roles || filter.roles.includes(u.role)) &&
    (!q || u.full_name.toLowerCase().includes(q.toLowerCase()) || (u.employee_id || "").toLowerCase().includes(q.toLowerCase()))
  );

  async function handleSave(form) {
    try {
      if (form.id) {
        await updateUserProfile(form.id, {
          full_name: form.full_name, role: form.role, employee_id: form.employee_id || null,
          department: form.department, designation: form.designation, mobile: form.mobile,
          linked_factory_code: form.linked_factory_code || null,
        });
      } else {
        const result = await createUser({ ...form, employee_id: form.employee_id || null, linked_factory_code: form.linked_factory_code || null });
        setTempPasswordNotice({ name: form.full_name, password: result.temp_password });
      }
      setEditing(null);
      await refresh();
    } catch (e) {
      // Both of these are correct, intentional protections (duplicate
      // email in Auth, duplicate employee_id in profiles) -- rephrased
      // here only for clarity, not because the underlying rejection is
      // wrong. Never suppress or soften what actually happened.
      if (e.message.includes("already been registered")) {
        setError(`Cannot create this user: the email "${form.email}" is already registered to another account.`);
      } else if (e.message.includes("already in use by another account")) {
        setError(e.message); // already clear -- the Edge Function's own message
      } else if (e.message.includes("profiles_employee_id_key")) {
        // The Edit path writes directly via updateUserProfile (no Edge
        // Function pre-check involved, unlike Create), so this is the raw
        // Postgres constraint violation surfacing as-is. Same protection,
        // just needed the same clarity treatment on this path too.
        setError("Employee ID already exists. Please enter a unique Employee ID.");
      } else {
        setError(e.message);
      }
    }
  }

  async function handleResetPassword(u) {
    try {
      const result = await resetPassword(u.id, u.role);
      setTempPasswordNotice({ name: u.full_name, password: result.temp_password });
    } catch (e) { setError(e.message); }
  }

  async function handleForcePasswordChange(u) {
    try {
      await forcePasswordChange(u.id, u.role);
      alert(`${u.full_name} will be required to set a new password at their next login. Their current password is unchanged.`);
    } catch (e) { setError(e.message); }
  }

  async function handleToggleActive(u) {
    try { await setUserActive(u.id, !u.is_active, u.role); await refresh(); }
    catch (e) { setError(e.message); }
  }

  async function handleDelete(u) {
    if (!window.confirm(`Permanently delete ${u.full_name}? This cannot be undone. If they own any real orders, this will correctly fail rather than orphan that data -- reassign those orders first if so.`)) return;
    try {
      await deleteUserPermanently(u.id, u.role);
      await refresh();
    } catch (e) {
      setError(e.message.includes("foreign key") || e.message.includes("orders")
        ? `Could not delete ${u.full_name} -- they still own real orders as primary merchandiser. Reassign those orders to someone else first, then try again.`
        : e.message);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 14, alignItems: "center" }}>
        {ROLE_FILTER_GROUPS.map(g => (
          <button key={g.label} className={filter.label === g.label ? "chip active" : "chip"} onClick={() => setFilter(g)}>{g.label}</button>
        ))}
        <input placeholder="Search name or employee ID..." value={q} onChange={e => setQ(e.target.value)} style={{ marginLeft: "auto", padding: 8 }} />
        <button className="btn-primary" onClick={() => setEditing({})}>Add User</button>
      </div>
      <p style={{ fontSize: 12, color: "#6B7280", marginTop: -8, marginBottom: 14 }}>
        The Factory and Shipping filters above are how Factory/Shipping Account
        Management works — one screen, filtered, rather than three near-identical
        ones. Same create/edit/deactivate/reset/overrides actions apply to every role.
      </p>

      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
      {loading ? <p>Loading...</p> : (
        <table className="data-table">
          <thead><tr><th>Name</th><th>Role</th><th>Department</th><th>Factory</th><th>Status</th><th>Last Login</th><th></th></tr></thead>
          <tbody>
            {visible.map(u => (
              <tr key={u.id}>
                <td>{u.full_name}<div style={{ fontSize: 11, color: "#9CA3AF" }}>{u.employee_id}</div></td>
                <td>{u.role_label}</td>
                <td>{u.department || "—"}</td>
                <td>{u.linked_factory_name || "—"}</td>
                <td>{u.is_active ? <span style={{ color: "#15803D" }}>Active</span> : <span style={{ color: "#B91C1C" }}>Deactivated</span>}</td>
                <td>{u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : "Never"}</td>
                <td style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button onClick={() => setEditing(u)}>Edit</button>
                  <button onClick={() => handleResetPassword(u)}>Reset Password</button>
                  <button onClick={() => handleForcePasswordChange(u)}>Force Change</button>
                  <button onClick={() => handleToggleActive(u)}>{u.is_active ? "Deactivate" : "Activate"}</button>
                  <button onClick={() => setOverridesUser(u)}>Overrides</button>
                  <button onClick={() => setHistoryUser(u)}>History</button>
                  <button onClick={() => handleDelete(u)} style={{ color: "#B91C1C", borderColor: "#FCA5A5" }}>Delete Permanently</button>
                </td>
              </tr>
            ))}
            {visible.length === 0 && <tr><td colSpan={7}>No users match this filter.</td></tr>}
          </tbody>
        </table>
      )}

      {editing !== null && <UserForm user={editing.id ? editing : null} roles={roles} onSave={handleSave} onCancel={() => setEditing(null)} />}
      {overridesUser && <UserOverrides user={overridesUser} onClose={() => setOverridesUser(null)} />}
      {historyUser && <UserHistory user={historyUser} onClose={() => setHistoryUser(null)} />}

      {tempPasswordNotice && (
        <div className="modal-backdrop">
          <div className="modal-box">
            <h3>Temporary Password for {tempPasswordNotice.name}</h3>
            <p>Relay this to them directly (in person, phone, chat) — no email was sent, per policy.</p>
            <code style={{ fontSize: 18, padding: 10, background: "#F3F4F6", display: "block", borderRadius: 6 }}>{tempPasswordNotice.password}</code>
            <p style={{ fontSize: 12, color: "#9CA3AF" }}>They'll be required to change it on first login.</p>
            <button className="btn-primary" onClick={() => setTempPasswordNotice(null)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
