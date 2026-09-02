import React, { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { getFilterOptions } from "../../lib/ordersApi.js";
import { seasonsIn } from "../../lib/reportsApi.js";
import { hasModulePermission } from "../../lib/permissions.js";
import {
  buildDashboard, scopeRows, dashboardViewForRole, canSwitchView,
  defaultOnlyMine, DASHBOARD_VIEWS, MAX_CLIENT_ORDERS,
} from "../../lib/dashboardApi.js";
import { summarise, startHere, EXPORT_COLUMNS, toExportRow } from "../../lib/notificationsApi.js";
import {
  loadOrganization, resolvePeriod, defaultPeriod, activeFilterLabels,
  DATE_BASIS_OPTIONS, reportFileName, exportHeaderBlock,
} from "../../lib/reportContext.js";
import ReportHeader from "../../components/ReportHeader.jsx";
import ReportFilterBar from "../../components/ReportFilterBar.jsx";
import ExcelPreviewModal from "../../components/ExcelPreviewModal.jsx";
import DataIntegrityNotice from "../../components/DataIntegrityNotice.jsx";
import ManagementView from "./ManagementView.jsx";
import MerchandiserView from "./MerchandiserView.jsx";
import ShippingView from "./ShippingView.jsx";

/* ==========================================================================
   The Dashboard — one personalized landing page.
   ==========================================================================
   Login → see what needs attention → click → fix it. That is the whole
   brief, and everything on this screen is measured against it.

   This file is a SHELL. It loads one dataset, scopes it to a view, and
   hands the result to a role body. It contains no business rule of its
   own: every count comes from the same notification engine the AI
   Assistant reads, and every business figure from the same reportsApi
   functions Reports Center reads. That is why the three screens cannot
   disagree — not because they were checked against each other, but because
   there is only one computation.

   The role picks the DEFAULT body. Module permissions decide what is
   actually rendered inside it, because this ERP is "permissions, not
   roles": a merchandiser who has been given shipping access should see the
   shipping section, not be locked out by their job title. */

const EMPTY_FILTERS = {
  dateBasis: "etd", factoryCode: "", merchandiserId: "", customerCode: "",
  productGroupCode: "", labelCode: "", divisionCode: "", businessUnitCode: "",
  season: "", status: "", style: "", po: "",
};

export default function Dashboard() {
  const { profile, dateFormat } = useOutletContext() || {};
  const role = profile?.role || "merchandiser";

  const [org, setOrg] = useState(null);
  const [options, setOptions] = useState({});
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [period, setPeriod] = useState(defaultPeriod());   // current fiscal year
  const [applied, setApplied] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [generatedAt, setGeneratedAt] = useState(null);
  const [view, setView] = useState(dashboardViewForRole(role));
  const [onlyMine, setOnlyMine] = useState(defaultOnlyMine(role));
  const [modules, setModules] = useState({});
  const [excelSheets, setExcelSheets] = useState(null);
  const [excelTitle, setExcelTitle] = useState("");

  useEffect(() => {
    loadOrganization().then(setOrg);
    getFilterOptions().then(setOptions).catch(() => {});
    /* Sections are gated by the same has_module_permission() the database
       uses, so the UI's "should I show this" and the database's "will this
       read succeed" are one function, not two that can drift. */
    Promise.all([
      hasModulePermission("orders", "view").catch(() => false),
      hasModulePermission("shipping_portal", "view").catch(() => false),
      hasModulePermission("reports", "view").catch(() => false),
      hasModulePermission("workbench", "view").catch(() => false),
    ]).then(([orders, shipping, reports, workbench]) =>
      setModules({ orders, shipping, reports, workbench }));
  }, []);

  async function generate() {
    const resolved = resolvePeriod(period);
    const query = { ...filters, dateFrom: resolved.dateFrom, dateTo: resolved.dateTo };
    setLoading(true); setError(null);
    try {
      const result = await buildDashboard(query, { userId: profile?.id, onlyMine });
      setData(result);
      setApplied({ ...query, periodLabel: resolved.label });
      setGeneratedAt(new Date());
      setDirty(false);
    } catch (e) { setError(e.message); }
    setLoading(false);
  }
  useEffect(() => { generate(); /* eslint-disable-next-line */ }, [onlyMine]);

  /* One computation, three views of it — the audience scope is applied to
     the finished rows, never by re-running the engine. */
  const rows = useMemo(
    () => scopeRows(data?.result?.rows, view),
    [data, view]
  );
  const summary = useMemo(
    () => data?.result ? summarise({ ...data.result, rows }) : null,
    [data, rows]
  );
  const plan = useMemo(() => summary ? startHere(summary, 5) : [], [summary]);
  const seasons = useMemo(() => data?.ds ? seasonsIn(data.ds.orders) : [], [data]);

  const periodLabel = applied?.periodLabel || "";
  const dateBasisLabel = (DATE_BASIS_OPTIONS.find(d => d[0] === (applied?.dateBasis || "etd")) || [])[1];
  const filterLabels = applied ? activeFilterLabels(applied, options) : [];
  const viewLabel = (DASHBOARD_VIEWS.find(v => v[0] === view) || [])[1] || view;

  /* Export uses the engine's own column set and the shared corporate
     header, so a Dashboard export and an AI Assistant export of the same
     alert are the same file. */
  function exportRows(exportable, reportName) {
    setExcelTitle(reportName);
    setExcelSheets([{
      name: reportName.slice(0, 28),
      header: exportHeaderBlock({
        org, reportName, periodLabel, dateBasisLabel, filters: applied || filters, options,
        viewLabel: `${viewLabel} dashboard${onlyMine ? " · only my orders" : ""}`,
        generatedAt, generatedBy: profile?.full_name || "",
      }),
      columns: EXPORT_COLUMNS.map(([, header]) => header),
      rows: exportable.map(toExportRow),
      totals: {
        "Notification Type": "Total",
        "PO": `${new Set(exportable.map(r => r.po)).size} POs`,
        "Order Qty": exportable.reduce((s, r) => s + (r.orderQty || 0), 0),
      },
    }]);
  }

  /* The scope the engine ran with, handed to the bodies so their KPI tiles
     count the SAME orders the rules ran over. Without it a merchandiser reads
     "My Active PO 198" — the whole company — above a list of their own 37
     alerts. */
  const scope = { userId: profile?.id, onlyMine };

  const bodyProps = {
    ds: data?.ds, rows, summary, plan, dateFormat, options, modules, scope,
    onExport: exportRows, profile, periodLabel,
  };

  return (
    <div className="rc-page db-page">
      <ReportHeader
        org={org}
        title={`Welcome, ${profile?.full_name || ""}`}
        subtitle={
          view === "management" ? "Where the business stands today, what is going wrong, and who needs to act"
          : view === "shipping" ? "What needs to ship, what is stuck, and what needs correcting"
          : "The orders that need you today, and the exact milestone that fixes each one"
        }
        periodLabel={periodLabel}
        dateBasisLabel={dateBasisLabel}
        generatedAt={generatedAt}
        generatedBy={profile?.full_name}
        filterLabels={filterLabels}
        recordCount={data?.ds?.orders?.length}
        right={
          <div className="db-headright">
            <button className="btn-outline" onClick={generate} disabled={loading}>{loading ? "Refreshing…" : "Refresh"}</button>
          </div>
        }
      />

      <div className="rc-card ai-viewbar db-viewbar">
        {canSwitchView(role) && (
          <div className="rpt-field">
            <span className="field-label">Viewing as</span>
            <div className="seg">
              {DASHBOARD_VIEWS.map(([k, l]) => (
                <button key={k} className={view === k ? "active" : ""} onClick={() => setView(k)}>{l}</button>
              ))}
            </div>
          </div>
        )}
        <div className="rpt-field">
          <span className="field-label">Scope</span>
          <label className="db-check">
            <input type="checkbox" checked={onlyMine} onChange={e => setOnlyMine(e.target.checked)} />
            Only orders where I'm the primary merchandiser
          </label>
        </div>
        <p className="rpt-hint db-hint">
          Every figure here is computed by the same engine the AI Assistant and Reports Center use — a number on this
          page and the same number there cannot disagree. Click any figure to open the records behind it.
        </p>
      </div>

      <ReportFilterBar
        filters={filters} onFilters={f => { setFilters(f); setDirty(true); }}
        period={period} onPeriod={p => { setPeriod(p); setDirty(true); }}
        options={options} seasons={seasons}
        showGrouping={false}
        onGenerate={generate} loading={loading} dirty={dirty}
        generateLabel="Apply filters"
      />

      {error && <p className="rpt-error">{error}</p>}
      {data?.ds && <DataIntegrityNotice integrity={data.ds.integrity} />}

      {data?.oversized && (
        <div className="rc-card db-oversized">
          <h3>This period is too large to open on a dashboard</h3>
          <p>
            {data.ds.orders.length.toLocaleString()} orders fall in this selection, past the {MAX_CLIENT_ORDERS.toLocaleString()}-order
            ceiling this screen holds itself to. A dashboard is a landing page, and pulling this much history into a browser
            would make it slow and no more useful. Narrow the period — a fiscal year or a quarter — or add a factory,
            customer or merchandiser filter. For whole-history analysis, Reports Center is the right screen.
          </p>
        </div>
      )}

      {loading && !data && <p className="rpt-loading">Reading your orders, milestones, CRDs and shipments…</p>}

      {data && !data.oversized && summary && (
        <>
          {view === "management" && <ManagementView {...bodyProps} />}
          {view === "merchandiser" && <MerchandiserView {...bodyProps} />}
          {view === "shipping" && <ShippingView {...bodyProps} />}
        </>
      )}

      {excelSheets && (
        <ExcelPreviewModal
          title={excelTitle}
          subtitle={`${viewLabel} dashboard`}
          meta={[periodLabel, dateBasisLabel && `by ${dateBasisLabel}`].filter(Boolean).join(" · ")}
          sheets={excelSheets}
          fileName={reportFileName(org, excelTitle, periodLabel, "xlsx")}
          onClose={() => setExcelSheets(null)}
        />
      )}
    </div>
  );
}
