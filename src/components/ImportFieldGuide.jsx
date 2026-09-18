import React, { useState } from "react";
import { fieldsFor, isRequired, helpFor, DATE_FORMATS, AMBIGUOUS_DATE_NOTE } from "../lib/importFields.js";

/* "Please mention somewhere for a user guide, so that all users know how to
   put order info for upload."

   Built from lib/importFields.js — the same list the importer checks and the
   template is generated from. A guide written separately would drift from the
   code within a release, and a guide that is wrong is worse than none: it
   tells somebody their file is fine when the import will refuse it.

   Collapsed by default. Somebody importing their fifth file this week does
   not need the rules on screen every time; somebody importing their first
   needs them one click away rather than in a document they have not been
   sent. */
export default function ImportFieldGuide({ source }) {
  const [open, setOpen] = useState(false);
  const fields = fieldsFor(source);
  const required = fields.filter(f => isRequired(f, source));

  return (
    <div className="ifg">
      <button className="ifg-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="ifg-caret">{open ? "▾" : "▸"}</span>
        How to fill in {source === "licensee" ? "a Licensee" : "a PLM"} file
        <span className="ifg-sub">
          {required.length} required column{required.length !== 1 ? "s" : ""} · date formats
        </span>
      </button>

      {open && (
        <div className="ifg-body">
          <p className="ifg-lead">
            Column headings must match the names below — the order they appear in does
            not matter, and extra columns are ignored. One row per{" "}
            <strong>PO + Style + Colour</strong>.
          </p>

          {source === "licensee" && (
            <p className="ifg-note">
              <strong>PO Prefix does not apply to Licensee orders.</strong> Put the
              licensee's whole PO reference in <code>PO #</code> exactly as they wrote
              it — for example <code>TP13-SP27 HATS</code>. Leave PO Prefix out, or
              blank.
            </p>
          )}

          <table className="data-table ifg-table">
            <thead>
              <tr><th>Column</th><th>Required</th><th>What goes in it</th></tr>
            </thead>
            <tbody>
              {fields.map(f => (
                <tr key={f.key} className={isRequired(f, source) ? "ifg-req" : ""}>
                  <td className="mono">{f.header}</td>
                  <td>
                    {isRequired(f, source)
                      ? <span className="ifg-yes">Required</span>
                      : <span className="ifg-opt">Optional</span>}
                  </td>
                  <td>{helpFor(f, source)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4 className="ifg-h">Dates</h4>
          <p className="ifg-lead">
            Applies to <code>Latest Required X-Country Ship Date</code> and{" "}
            <code>PO Issue Date</code>. Any of these work:
          </p>
          <ul className="ifg-dates">
            {DATE_FORMATS.map(d => (
              <li key={d.label}>
                <strong>{d.label}</strong> <code>{d.example}</code>
                <span className="ifg-dnote">{d.note}</span>
              </li>
            ))}
          </ul>
          <p className="ifg-warn">{AMBIGUOUS_DATE_NOTE}</p>

          <h4 className="ifg-h">What happens on import</h4>
          <ul className="ifg-dates">
            <li>A row whose PO + Style + Colour already exists is an <strong>update</strong>, not a duplicate.</li>
            <li>Customer, Division, Label and Product Group are matched by name. An unmatched one still imports, with a note.</li>
            {source === "licensee" && (
              <li>
                The ship date and unit price <strong>are</strong> taken from a Licensee
                file — but only where the order does not already have one, so a date
                revised here is never reverted by a re-import.
              </li>
            )}
            <li>Nothing is written until you press Import. Analyse only reads the file.</li>
          </ul>
        </div>
      )}
    </div>
  );
}
