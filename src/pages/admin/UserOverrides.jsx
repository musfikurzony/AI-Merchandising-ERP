import React, { useEffect, useState } from "react";
import { listUserOverrides, setFinePermissionOverride, setModulePermissionOverride, listFinePermissions, MODULE_KEYS, MODULE_ACTIONS } from "../../lib/adminApi.js";

// Three-state control: Inherit (from role) / Allow / Deny -- this is what
// makes an override genuinely OPTIONAL, matching "no override = inherits
// Role" exactly. `value` is null (inherit), true (allow), or false (deny).
function TriState({ value, onChange }) {
  return (
    <select value={value === null ? "inherit" : value ? "allow" : "deny"}
      onChange={e => onChange(e.target.value === "inherit" ? null : e.target.value === "allow")}>
      <option value="inherit">Inherit</option>
      <option value="allow">Allow</option>
      <option value="deny">Deny</option>
    </select>
  );
}

export default function UserOverrides({ user, onClose }) {
  const [finePerms, setFinePerms] = useState([]);
  const [overrides, setOverrides] = useState({ finePermissions: [], modulePermissions: [] });
  const [error, setError] = useState(null);

  async function refresh() {
    const [fp, ov] = await Promise.all([listFinePermissions(), listUserOverrides(user.id)]);
    setFinePerms(fp); setOverrides(ov);
  }
  useEffect(() => { refresh(); }, [user.id]);

  function fineOverrideValue(key) {
    const row = overrides.finePermissions.find(o => o.permission_key === key);
    return row ? row.allowed : null;
  }
  async function handleFine(key, value) {
    try { await setFinePermissionOverride(user.id, key, value); await refresh(); }
    catch (e) { setError(e.message); }
  }

  function moduleOverrideValue(moduleKey, action) {
    const row = overrides.modulePermissions.find(o => o.module_key === moduleKey);
    const col = { view: "can_view", add: "can_add", edit: "can_edit", delete: "can_delete", export: "can_export", approve: "can_approve" }[action];
    return row ? row[col] : null; // null column value = inherit, same semantics as no row at all
  }
  async function handleModule(moduleKey, action, value) {
    try { await setModulePermissionOverride(user.id, moduleKey, action, value); await refresh(); }
    catch (e) { setError(e.message); }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal-box" style={{ width: 720, maxHeight: "80vh", overflowY: "auto" }}>
        <h3>Permission Overrides — {user.full_name}</h3>
        <p style={{ fontSize: 12, color: "#6B7280" }}>
          Base role: <strong>{user.role_label}</strong>. Anything left as "Inherit" uses the role's
          default — set "Allow" or "Deny" only for the specific exceptions this person needs.
        </p>
        {error && <p style={{ color: "#B91C1C" }}>{error}</p>}

        <h4>Module Permissions</h4>
        <table className="data-table">
          <thead><tr><th>Module</th>{MODULE_ACTIONS.map(a => <th key={a} style={{ textTransform: "capitalize" }}>{a}</th>)}</tr></thead>
          <tbody>
            {MODULE_KEYS.map(mk => (
              <tr key={mk}>
                <td>{mk.replace(/_/g, " ")}</td>
                {MODULE_ACTIONS.map(a => (
                  <td key={a}><TriState value={moduleOverrideValue(mk, a)} onChange={v => handleModule(mk, a, v)} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <h4 style={{ marginTop: 20 }}>Additional Permissions</h4>
        <table className="data-table">
          <thead><tr><th>Permission</th><th>Override</th></tr></thead>
          <tbody>
            {finePerms.map(p => (
              <tr key={p.key}>
                <td>{p.label}</td>
                <td><TriState value={fineOverrideValue(p.key)} onChange={v => handleFine(p.key, v)} /></td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ marginTop: 16, textAlign: "right" }}>
          <button className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
