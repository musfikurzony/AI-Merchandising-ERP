import React from "react";

/* Says out loud when a screen's numbers may be incomplete.

   Every dataset is fetched with paging and then reconciled against an exact
   COUNT taken separately. If those two disagree, rows exist that this
   browser did not receive — and once data reaches a rule, a row that never
   arrived is indistinguishable from a fact that was never recorded. An
   "overdue" list built on a short read looks entirely normal and is wrong.

   So the reconciliation result is shown, not logged: a mismatch is a
   warning the user can act on, and a count that could not be taken is
   reported as unknown rather than assumed fine. When everything reconciles
   the component renders nothing — a green tick on every screen would train
   people to stop reading it. */

export default function DataIntegrityNotice({ integrity, compact }) {
  if (!integrity || integrity.ok) return null;

  const failures = integrity.failures || [];
  const unknown = (integrity.checks || []).filter(c => c.ok === null);

  return (
    <div className={"bk-note " + (failures.length ? "warn" : "")} style={{ marginBottom: 16 }}>
      {failures.length > 0 ? (
        <>
          <strong>These figures may be incomplete.</strong> {failures.length === 1 ? "One dataset" : `${failures.length} datasets`} returned
          fewer rows than the database says exist for this selection, so any count on this screen could be understated:
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {failures.map(c => (
              <li key={c.label} style={{ marginBottom: 3 }}>
                <strong>{c.label}</strong> — received {Number(c.fetched).toLocaleString()} of {c.expected == null ? "an unknown number of" : Number(c.expected).toLocaleString()} rows
                {c.error ? <> · {c.error}</> : null}
              </li>
            ))}
          </ul>
          <div style={{ marginTop: 8 }}>
            Narrow the period or filters and try again. If it persists, send this message on — it means the data layer needs attention, not the filters.
          </div>
        </>
      ) : (
        <>
          <strong>Row counts could not be verified.</strong> The data loaded, but the database would not return a count to check it
          against ({unknown.map(c => c.label).join(", ")}), so completeness is unconfirmed on this screen.
        </>
      )}
    </div>
  );
}
