import React from "react";

/* "This is a draft, not a saved record."

   The line that makes restoring a half-filled form safe rather than
   confusing. A form that silently reopens full of text invites the reader to
   assume it was saved; this says plainly that it was not, and gives one click
   to throw it away.

   It is the whole reason a FORM draft can be restored when the Workbench grid
   deliberately is not: there, restored values are indistinguishable from
   saved ones. Here they cannot be. */
export default function DraftNotice({ restored, onDiscard, what = "entry" }) {
  if (!restored) return null;
  return (
    <div className="dn-note" role="status">
      <span className="dn-icon" aria-hidden="true">✎</span>
      <span>Unsaved {what} restored from earlier — <strong>nothing has been saved yet.</strong></span>
      <button className="dn-discard" onClick={onDiscard}>Discard draft</button>
    </div>
  );
}
