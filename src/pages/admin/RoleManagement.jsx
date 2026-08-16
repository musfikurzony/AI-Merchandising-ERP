import React, { useEffect, useState } from "react";
import {
  listRoles, cloneRole, listModulePermissions, upsertModulePermission,
  listFinePermissions, listRolePermissions, upsertRolePermission,
  MODULE_KEYS, MODULE_ACTIONS,
} from "../../lib/adminApi.js";

export default function RoleManagement() {
  const [roles, setRoles] = useState([]);
  const [selectedRole, setSelectedRole] = useState(null);
  const [modulePerms, setModulePerms] = useState([]);
  const [finePerms, setFinePerms] = useState([]);
  const [rolePerms, setRolePerms] = useState([]);
  const [showClone, setShowClone] = useState(false);
  const [cloneForm, setCloneForm] = useState({ newKey: "", newLabel: "" });
  const [error, setError] = useState(null);

  useEffect(() => {
    listRoles().then(r => { setRoles(r); if (r.length) setSelectedRole(r[0].key); });
    listFinePermissions().then(setFinePerms);
  }, []);

  useEffect(() => {
    if (!selectedRole) return;
    listModulePermissions(selectedRole).then(setModulePerms);
    listRolePermissions(selectedRole).then(setRolePerms);
  }, [selectedRole]);

  function moduleValue(moduleKey, action) {
    const row = modulePerms.find(m => m.module_key === moduleKey);
    const col = { view: "can_view", add: "can_add", edit: "can_edit", delete: "can_delete", export: "can_export", approve: "can_approve" }[action];
    return row ? !!row[col] : false;
  }

  async function toggleModule(moduleKey, action) {
    const newVal = !moduleValue(moduleKey, action);
    try {
      await upsertModulePermission(selectedRole, moduleKey, action, newVal);
      setModulePerms(await listModulePermissions(selectedRole));
    } catch (e) { setError(e.message); }
  }

  function fineValue(key) {
    const row = rolePerms.find(p => p.permission_key === key);
    return row ? row.allowed : false;
  }

  async function toggleFine(key) {
    try {
      await upsertRolePermission(selectedRole, key, !fineValue(key));
      setRolePerms(await listRolePermissions(selectedRole));
    } catch (e) { setError(e.message); }
  }

  async function handleClone() {
    try {
      await cloneRole(selectedRole, cloneForm.newKey, cloneForm.newLabel);
      setRoles(await listRoles());
      setShowClone(false);
      setCloneForm({ newKey: "", newLabel: "" });
    } catch (e) { setError(e.message); }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16 }}>
        <label>Role
          <select value={selectedRole || ""} onChange={e => setSelectedRole(e.target.value)} style={{ marginLeft: 8 }}>
            {roles.map(r => <option key={r.key} value={r.key}>{r.label}{r.is_system_role ? "" : " (custom)"}</option>)}
          </select>
        </label>
        <button onClick={() => setShowClone(true)}>Copy This Role...</button>
      </div>
      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}

      <h3>Module Permissions</h3>
      <table className="data-table">
        <thead><tr><th>Module</th>{MODULE_ACTIONS.map(a => <th key={a} style={{ textTransform: "capitalize" }}>{a}</th>)}</tr></thead>
        <tbody>
          {MODULE_KEYS.map(mk => (
            <tr key={mk}>
              <td>{mk.replace(/_/g, " ")}</td>
              {MODULE_ACTIONS.map(a => (
                <td key={a}><input type="checkbox" checked={moduleValue(mk, a)} onChange={() => toggleModule(mk, a)} /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 24 }}>Additional Permissions</h3>
      <table className="data-table">
        <thead><tr><th>Permission</th><th>Description</th><th>Allowed</th></tr></thead>
        <tbody>
          {finePerms.map(p => (
            <tr key={p.key}>
              <td>{p.label}</td><td style={{ fontSize: 12, color: "#6B7280" }}>{p.description}</td>
              <td><input type="checkbox" checked={fineValue(p.key)} onChange={() => toggleFine(p.key)} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      {showClone && (
        <div className="modal-backdrop">
          <div className="modal-box">
            <h3>Copy "{roles.find(r => r.key === selectedRole)?.label}"</h3>
            <label className="field">New Role Key (no spaces, e.g. senior_merchandiser)
              <input value={cloneForm.newKey} onChange={e => setCloneForm({ ...cloneForm, newKey: e.target.value })} />
            </label>
            <label className="field">New Role Label
              <input value={cloneForm.newLabel} onChange={e => setCloneForm({ ...cloneForm, newLabel: e.target.value })} />
            </label>
            <p style={{ fontSize: 12, color: "#6B7280" }}>Copies every module and fine-grained permission from the source role as a starting point — adjust the new role afterward.</p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setShowClone(false)}>Cancel</button>
              <button className="btn-primary" onClick={handleClone}>Create Role</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
