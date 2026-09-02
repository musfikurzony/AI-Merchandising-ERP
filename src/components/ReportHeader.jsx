import React from "react";
import { orgTitleLine, formatGeneratedAt } from "../lib/reportContext.js";

/* The corporate report header, used by every report screen and mirrored
   in the PDF and Excel exports.

   What it shows, and why each part earns its place:
     - The organisation as an Administrator actually configured it (logo,
       company name, branch) — not a hardcoded string.
     - The report's own name and one line saying what it measures.
     - WHEN it was generated, to the minute, and BY WHOM. A report that
       gets printed, emailed and quoted in a meeting three weeks later
       needs to say how old it is; "yesterday's numbers" and "last month's
       numbers" look identical without this.
     - The period it covers, stated in business language ("FY2027 Q2"),
       not as two raw ISO dates.
     - Every filter that is actually applied, as chips — so a filtered
       report can never be mistaken for the whole business.
     - How many records the figures were computed from.  */

export default function ReportHeader({
  org, title, subtitle, periodLabel, dateBasisLabel,
  generatedAt, generatedBy, filterLabels = [], recordCount, recordNoun = "orders",
  right,
}) {
  const initials = (org?.company_name || "PE").split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <div className="rpt-header">
      <div className="rpt-header-top">
        <div className="rpt-identity">
          {org?.logo_url
            ? <img src={org.logo_url} alt="" className="rpt-logo" />
            : <span className="rpt-logo-tile">{initials}</span>}
          <div>
            <div className="rpt-company">{orgTitleLine(org)}</div>
            {org?.address && <div className="rpt-company-sub">{org.address}</div>}
          </div>
        </div>
        <div className="rpt-stamp">
          <div><span className="k">Generated</span> {formatGeneratedAt(generatedAt)}</div>
          {generatedBy && <div><span className="k">By</span> {generatedBy}</div>}
          {periodLabel && <div><span className="k">Period</span> {periodLabel}{dateBasisLabel ? ` · ${dateBasisLabel}` : ""}</div>}
        </div>
      </div>

      <div className="rpt-title-row">
        <div>
          <h2 className="rpt-title">{title}</h2>
          {subtitle && <p className="rpt-subtitle">{subtitle}</p>}
        </div>
        {right && <div className="rpt-title-actions">{right}</div>}
      </div>

      {(filterLabels.length > 0 || recordCount != null) && (
        <div className="rpt-filters">
          {recordCount != null && (
            <span className="rpt-chip strong">{Number(recordCount).toLocaleString()} {recordNoun}</span>
          )}
          {filterLabels.map(f => <span className="rpt-chip" key={f}>{f}</span>)}
          {filterLabels.length === 0 && <span className="rpt-chip muted">No filters applied — whole business</span>}
        </div>
      )}
    </div>
  );
}
