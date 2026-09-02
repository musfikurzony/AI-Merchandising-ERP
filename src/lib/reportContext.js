import { getOrganizationSettings } from "./adminApi.js";
import { getFiscalYear, getFiscalYearRange, fiscalYearLabel, setFiscalYearStartMonth, getFiscalYearStartMonth } from "./reportsApi.js";

/* Report identity + period resolution — the shared layer every report
   screen, every PDF and every Excel export reads its header from.

   Two things were previously repeated (and therefore able to drift) on
   every report: the company name (hardcoded as a literal in the PDF
   generator) and the period-to-date-range conversion (re-implemented per
   screen). Both now live here, once.

   The company name is the one an Administrator actually typed into
   Organization Settings — a report that says "PERRY ELLIS INTERNATIONAL"
   because it is hardcoded is lying about where its identity comes from,
   and would keep saying it after a rename. */

let orgCache = null;
let orgPromise = null;

export const FALLBACK_ORG = {
  company_name: "Perry Ellis International",
  branch: "Bangladesh",
  address: "",
  website: "",
  logo_url: "",
  fiscal_year_start_month: 2,
};

/* Cached for the session: this is read by every report header, and it is
   settings data that changes at most a few times a year. A failure to read
   it must never break a report — it falls back to the known name and the
   report still renders. */
export async function loadOrganization() {
  if (orgCache) return orgCache;
  if (!orgPromise) {
    orgPromise = getOrganizationSettings()
      .then(o => {
        orgCache = { ...FALLBACK_ORG, ...(o || {}) };
        /* The fiscal calendar is organisation configuration, so it is applied
           here, once, when the organisation is first read — before any screen
           resolves a period. A deployment without migration 37 has no such
           column and the setter falls back to February, which is what every
           existing report already assumed. */
        setFiscalYearStartMonth(orgCache.fiscal_year_start_month);
        return orgCache;
      })
      .catch(() => { orgCache = FALLBACK_ORG; return orgCache; });
  }
  return orgPromise;
}

export function orgTitleLine(org) {
  const o = org || FALLBACK_ORG;
  return [o.company_name, o.branch].filter(Boolean).join(" — ");
}

/* ---------------------------------------------------------------------
   Periods. One definition, five ways of expressing it.
   --------------------------------------------------------------------- */

export const PERIOD_MODES = [
  ["fy", "Fiscal year"],
  ["quarter", "Quarter"],
  ["month", "Month"],
  ["range", "Date range"],
  ["all", "All time"],
];

export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/* Fiscal quarters follow the fiscal year, not the calendar: FY2027 runs
   Feb-2026 → Jan-2027, so Q1 is Feb–Apr, Q2 May–Jul, Q3 Aug–Oct, Q4
   Nov–Jan. Deriving them from getFiscalYearRange() rather than hardcoding
   month numbers means they can never disagree with the fiscal year
   definition itself. */
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/* Labels are derived from the configured start month rather than written out,
   so "Q1 (Feb–Apr)" becomes "Q1 (Apr–Jun)" automatically if the financial
   calendar ever moves. With the February default the four labels are exactly
   the strings that were hardcoded before. */
function quarterLabel(offset) {
  const start = (getFiscalYearStartMonth() - 1 + offset) % 12;
  const end = (start + 2) % 12;
  return `${SHORT_MONTHS[start]}–${SHORT_MONTHS[end]}`;
}

const QUARTER_OFFSETS = [["Q1", 0], ["Q2", 3], ["Q3", 6], ["Q4", 9]];

/* A function rather than a constant: the labels depend on a setting that is
   read at sign-in, so a constant evaluated at module load would freeze the
   old labels in place. Called wherever the quarter list is rendered. */
export function fiscalQuarters() {
  return QUARTER_OFFSETS.map(([k, o]) => [k, `${k} (${quarterLabel(o)})`, o]);
}

function isoDay(y, mIndex, d) {
  return `${y}-${String(mIndex + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function lastDayOfMonth(y, mIndex) {
  return new Date(y, mIndex + 1, 0).getDate();
}

export function fiscalQuarterRange(fiscalYear, quarterKey) {
  const list = fiscalQuarters();
  const q = list.find(x => x[0] === quarterKey) || list[0];
  const startOffset = q[2];
  const { start } = getFiscalYearRange(fiscalYear);   // e.g. 2026-02-01
  const startDate = new Date(start);
  startDate.setMonth(startDate.getMonth() + startOffset);
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + 3);
  endDate.setDate(0); // last day of the third month
  return {
    start: isoDay(startDate.getFullYear(), startDate.getMonth(), 1),
    end: isoDay(endDate.getFullYear(), endDate.getMonth(), endDate.getDate()),
  };
}

/* Turns whatever the user picked into { dateFrom, dateTo, label } — the
   single conversion every screen uses, so "FY2027" means exactly the same
   range in the Executive Dashboard, Reports Center and On-Time
   Performance. */
export function resolvePeriod(period) {
  const { mode, fiscalYear, quarter, month, monthYear, dateFrom, dateTo } = period || {};
  if (mode === "fy" && fiscalYear) {
    const { start, end } = getFiscalYearRange(Number(fiscalYear));
    return { dateFrom: start, dateTo: end, label: fiscalYearLabel(Number(fiscalYear)) };
  }
  if (mode === "quarter" && fiscalYear && quarter) {
    const { start, end } = fiscalQuarterRange(Number(fiscalYear), quarter);
    return { dateFrom: start, dateTo: end, label: `${fiscalYearLabel(Number(fiscalYear))} ${quarter}` };
  }
  if (mode === "month" && monthYear && month !== "" && month != null) {
    const y = Number(monthYear), m = Number(month);
    return {
      dateFrom: isoDay(y, m, 1),
      dateTo: isoDay(y, m, lastDayOfMonth(y, m)),
      label: `${MONTH_NAMES[m]} ${y}`,
    };
  }
  if (mode === "range" && (dateFrom || dateTo)) {
    return { dateFrom: dateFrom || "", dateTo: dateTo || "", label: `${dateFrom || "…"} to ${dateTo || "…"}` };
  }
  return { dateFrom: "", dateTo: "", label: "All time" };
}

export function defaultPeriod() {
  const currentFy = getFiscalYear(new Date().toISOString().slice(0, 10));
  return { mode: "fy", fiscalYear: String(currentFy), quarter: "Q1", month: String(new Date().getMonth()), monthYear: String(new Date().getFullYear()), dateFrom: "", dateTo: "" };
}

export function fiscalYearChoices() {
  const current = getFiscalYear(new Date().toISOString().slice(0, 10));
  return [current - 3, current - 2, current - 1, current, current + 1];
}

export const DATE_BASIS_OPTIONS = [
  ["etd", "ETD"],
  ["revised_etd", "Revised ETD"],
  ["po_issue", "PO Issue Date"],
  ["actual_etd", "Actual ETD"],
  ["crd", "CRD"],
];

/* ---------------------------------------------------------------------
   The dynamic header line.
   --------------------------------------------------------------------- */

/* Only the filters that are ACTUALLY SET appear — a header listing "All
   Factories · All Customers · All Labels" tells the reader nothing and
   makes the ones that matter harder to spot. The labels are resolved to
   real names (not codes), because a printed report is read by people who
   don't know the code table. */
export function activeFilterLabels(filters, options, dimensionLabel) {
  const out = [];
  const find = (list, key, val) => (list || []).find(x => x[key] === val);
  if (filters.factoryCode) out.push(`Factory: ${find(options.factories, "code", filters.factoryCode)?.name || filters.factoryCode}`);
  if (filters.merchandiserId) out.push(`Merchandiser: ${find(options.merchandisers, "id", filters.merchandiserId)?.full_name || filters.merchandiserId}`);
  if (filters.customerCode) out.push(`Customer: ${find(options.customers, "code", filters.customerCode)?.name || filters.customerCode}`);
  if (filters.productGroupCode) out.push(`Product Group: ${find(options.productGroups, "code", filters.productGroupCode)?.name || filters.productGroupCode}`);
  if (filters.labelCode) out.push(`Label: ${find(options.labels, "code", filters.labelCode)?.name || filters.labelCode}`);
  if (filters.divisionCode) out.push(`Division: ${find(options.divisions, "code", filters.divisionCode)?.name || filters.divisionCode}`);
  if (filters.businessUnitCode) out.push(`Business Unit: ${find(options.businessUnits, "code", filters.businessUnitCode)?.name || filters.businessUnitCode}`);
  if (filters.season) out.push(`Season: ${filters.season}`);
  if (filters.status) out.push(`Status: ${filters.status}`);
  if (filters.style) out.push(`Style contains: ${filters.style}`);
  if (filters.po) out.push(`PO contains: ${filters.po}`);
  if (dimensionLabel) out.push(`Grouped by: ${dimensionLabel}`);
  return out;
}

export function countActiveFilters(filters) {
  const keys = ["factoryCode", "merchandiserId", "customerCode", "productGroupCode", "labelCode", "divisionCode", "businessUnitCode", "season", "status", "style", "po"];
  return keys.filter(k => filters[k]).length;
}

export function formatGeneratedAt(date) {
  return (date || new Date()).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/* Every export's file name in one shape: company slug, report, period,
   date. Predictable enough that a folder of them sorts sensibly. */
export function reportFileName(org, reportName, periodLabel, ext) {
  const slug = s => String(s || "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return [slug(org?.company_name || "PEI"), slug(reportName), slug(periodLabel), new Date().toISOString().slice(0, 10)]
    .filter(Boolean).join("_") + "." + ext;
}

/* ---------------------------------------------------------------------
   The corporate header block written above an exported sheet.
   ---------------------------------------------------------------------
   Lifted out of AiAssistant so that every screen that exports — the AI
   Assistant, the Dashboard, and anything added later — produces a byte-
   identical header. A sheet that lands in someone's inbox has to say what
   it is, what period it covers and what was filtered out, or it cannot be
   trusted as a management document; having two functions that each try to
   say that is how the two start disagreeing. */
export function exportHeaderBlock({
  org, reportName, reportType = "Operational Exception Report",
  periodLabel, dateBasisLabel, filters = {}, options = {},
  viewLabel = "", generatedAt, generatedBy = "",
}) {
  const nameOf = (list, key, val, nameKey = "name") =>
    val ? ((options[list] || []).find(x => x[key] === val)?.[nameKey] || val) : null;

  const lines = [
    [orgTitleLine(org).toUpperCase()],
    ["AI MERCHANDISING ERP"],
    [`REPORT NAME: ${reportName}`],
    [`REPORT TYPE: ${reportType}`],
    [`PERIOD: ${periodLabel || "All time"}`],
    [`DATE BASIS: ${dateBasisLabel || "ETD"}`],
    [`FACTORY: ${nameOf("factories", "code", filters.factoryCode) || "All factories"}`],
    [`MERCHANDISER: ${nameOf("merchandisers", "id", filters.merchandiserId, "full_name") || "All merchandisers"}`],
    [`CUSTOMER: ${nameOf("customers", "code", filters.customerCode) || "All customers"}`],
    [`PRODUCT GROUP: ${nameOf("productGroups", "code", filters.productGroupCode) || "All product groups"}`],
    [`LABEL: ${nameOf("labels", "code", filters.labelCode) || "All labels"}`],
  ];
  if (viewLabel) lines.push([`VIEW: ${viewLabel}`]);
  lines.push([`GENERATED: ${formatGeneratedAt(generatedAt)}${generatedBy ? ` by ${generatedBy}` : ""}`]);
  lines.push([]);
  return lines;
}
