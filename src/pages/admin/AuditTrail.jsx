import React, { useEffect, useState } from "react";
import { listAuditLog } from "../../lib/adminApi.js";

export default function AuditTrail() {
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listAuditLog({ limit: 200 }).then(setEntries).catch(e => setError(e.message)).finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <p style={{ fontSize: 12, color: "#6B7280" }}>
        Append-only — every field change, delete approval/rejection, shipment lock/unlock,
        and CRD update is recorded here automatically. Nothing can be edited or removed,
        including by an Admin — that's what makes this a real audit trail.
      </p>
      {error && <p style={{ color: "#B91C1C" }}>{error}</p>}
      {loading ? <p>Loading...</p> : (
        <table className="data-table">
          <thead><tr><th>When</th><th>Action</th><th>Field</th><th>Old Value</th><th>New Value</th></tr></thead>
          <tbody>
            {entries.map(e => (
              <tr key={e.id}>
                <td>{new Date(e.created_at).toLocaleString()}</td>
                <td>{e.action}</td>
                <td>{e.field_name || "—"}</td>
                <td>{e.old_value || "—"}</td>
                <td>{e.new_value || "—"}</td>
              </tr>
            ))}
            {entries.length === 0 && <tr><td colSpan={5}>No activity yet.</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  );
}
