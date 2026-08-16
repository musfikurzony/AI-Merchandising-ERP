import React, { useEffect, useState } from "react";
import { listAuditLog } from "../../lib/adminApi.js";

export default function UserHistory({ user, onClose }) {
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    listAuditLog({ targetUserId: user.id, limit: 50 })
      .then(setEntries).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, [user.id]);

  return (
    <div className="modal-backdrop">
      <div className="modal-box" style={{ width: 520, maxHeight: "70vh", overflowY: "auto" }}>
        <h3>Account History — {user.full_name}</h3>
        <p style={{ fontSize: 12, color: "#6B7280" }}>
          Every account action taken on this user — created, activated/deactivated,
          password reset or forced change, role or permission edits — recorded
          automatically, append-only.
        </p>
        {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
        {loading ? <p>Loading...</p> : (
          <table className="data-table">
            <thead><tr><th>When</th><th>Action</th><th>Field</th><th>Old</th><th>New</th></tr></thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id}>
                  <td>{new Date(e.created_at).toLocaleString()}</td>
                  <td>{e.action}</td><td>{e.field_name || "—"}</td>
                  <td>{e.old_value || "—"}</td><td>{e.new_value || "—"}</td>
                </tr>
              ))}
              {entries.length === 0 && <tr><td colSpan={5}>No history yet.</td></tr>}
            </tbody>
          </table>
        )}
        <div style={{ marginTop: 14, textAlign: "right" }}>
          <button className="btn-primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
