import { supabase } from "./supabaseClient.js";
import { buildReportDataset, orderMetrics } from "./reportsApi.js";
import { fetchAllPaged as sharedFetchAllPaged, chunk as sharedChunk, PAGE_SIZE as SHARED_PAGE_SIZE, ID_CHUNK as SHARED_ID_CHUNK } from "./supabaseFetch.js";

/* Backup & Export — controlled data export.

   Three honesty points that shape this whole module:

   1. THIS IS AN EXPORT, NOT A SERVER-SIDE DATABASE BACKUP. It reads
      through the same PostgREST API and the same Row Level Security the
      rest of the app uses, as the signed-in user — so it exports exactly
      what THAT USER may see. Correct security behaviour, but it means the
      file is a scoped extract, not a byte-for-byte dump. Real disaster
      recovery is Supabase's own scheduled backup (or `pg_dump`), and the
      UI says so rather than implying this replaces it.

   2. PostgREST caps a single request's rows (1,000 by default). Fetching a
      table with one .select() and trusting the result is exactly how an
      "export" silently produces a truncated file that looks complete.
      Every fetch here is PAGED, and every dataset's exported row count is
      reconciled against a separate exact COUNT — a mismatch is surfaced,
      never swallowed.

   3. SCOPING A CHILD TABLE BY ITS OWN DATE WOULD BE WRONG. When a period
      is applied, the ORDERS are filtered first, and colour ways,
      milestones, CRD updates and shipment lines are then fetched BY THOSE
      ORDER IDs. Filtering `order_milestones` by its own dates would drop
      the milestones of an in-scope order and produce an internally
      inconsistent export — rows referencing parents that aren't in the
      file. */

/* The paging/chunking pattern this module pioneered now lives in
   supabaseFetch.js, shared with the reporting layer — imported here rather
   than kept as a second copy that could drift. */
const PAGE_SIZE = SHARED_PAGE_SIZE;
const ID_CHUNK = SHARED_ID_CHUNK;

/* scope:
   - "none"     : always the whole table (master data, admin)
   - "byOrder"  : filtered to the in-scope order ids via order_id
   - "byOrderId": the orders table itself, filtered by id
   - { date: "col" } : filtered on its own date column
   - "composite": not a table at all — built from the report dataset */
export const BACKUP_DATASETS = [
  // --- The one most people actually want ------------------------------
  { key: "order_book_colour", label: "Order book — colour level", category: "Order book", scope: "composite",
    description: "One row per PO + Style + Colour, with quantity, FOB, value, all classification fields, dates, factory, merchandiser, and shipped / balance against that colour. This is the export to take into Excel." },
  { key: "shipment_lines_detail", label: "Shipments — colour level", category: "Order book", scope: "composite",
    description: "One row per real shipment line: PO, style, colour, shipped qty, price, value, invoice, vessel, dates, destination. A colour shipped twice produces two rows, correctly." },

  // --- Transactional (raw tables, exactly as stored) -------------------
  { key: "orders", label: "Orders (raw table)", category: "Transactional", table: "orders", select: "*", order: "created_at", scope: "byOrderId",
    description: "The `orders` rows themselves, every column as stored." },
  { key: "order_color_ways", label: "Order colour ways", category: "Transactional", table: "order_color_ways", select: "*", order: "order_id", scope: "byOrder",
    description: "Colour-level quantities behind each order." },
  { key: "order_milestones", label: "T&A milestones", category: "Transactional", table: "order_milestones", select: "*", order: "order_id", scope: "byOrder",
    description: "Plan vs actual dates per milestone — the Workbench's data." },
  { key: "crd_updates", label: "CRD updates", category: "Transactional", table: "crd_updates", select: "*", order: "created_at", scope: "byOrder",
    description: "Every CRD change with who made it and when." },
  { key: "shipments", label: "Shipments (headers)", category: "Transactional", table: "shipments", select: "*", order: "created_at", scope: { date: "actual_etd" },
    description: "Invoice, vessel, booking, actual ETD/ETA, lock state." },
  { key: "shipment_lines", label: "Shipment lines (raw table)", category: "Transactional", table: "shipment_lines", select: "*", order: "shipment_id", scope: "byOrder",
    description: "The raw shipment_lines rows." },
  { key: "po_cancellation_requests", label: "PO cancellations", category: "Transactional", table: "po_cancellation_requests", select: "*", order: "created_at", scope: { date: "created_at" },
    description: "Cancellation requests with reason, approver and outcome." },

  // --- Master data -----------------------------------------------------
  { key: "factories", label: "Factories", category: "Master data", table: "factories", select: "*", order: "name", scope: "none", description: "Vendor / factory master." },
  { key: "customers", label: "Customers", category: "Master data", table: "customers", select: "*", order: "name", scope: "none", description: "Customer master." },
  { key: "labels", label: "Labels", category: "Master data", table: "labels", select: "*", order: "name", scope: "none", description: "Brand / label master." },
  { key: "product_groups", label: "Product groups", category: "Master data", table: "product_groups", select: "*", order: "name", scope: "none", description: "Product group master." },
  { key: "divisions", label: "Divisions", category: "Master data", table: "divisions", select: "*", order: "name", scope: "none", description: "Division master." },
  { key: "business_units", label: "Business units", category: "Master data", table: "business_units", select: "*", order: "name", scope: "none", description: "Business unit master." },
  { key: "tna_milestone_types", label: "Milestone types", category: "Master data", table: "tna_milestone_types", select: "*", order: "key", scope: "none", description: "T&A milestone definitions and critical-path flags." },

  // --- Administration --------------------------------------------------
  { key: "profiles", label: "Users (profiles)", category: "Administration", table: "profiles", select: "id, full_name, email, role, is_active, created_at", order: "full_name", scope: "none",
    description: "User accounts — no passwords or auth tokens are readable through this API at all." },
  { key: "import_batches", label: "Import history", category: "Administration", table: "import_batches", select: "*", order: "created_at", scope: { date: "created_at" }, description: "Every PLM / licensee import with its counts." },
  { key: "audit_log", label: "Audit log", category: "Administration", table: "audit_log", select: "*", order: "created_at", scope: { date: "created_at" }, description: "Who changed what, when. Can be large." },
];

export const BACKUP_CATEGORIES = ["Order book", "Transactional", "Master data", "Administration"];

export function datasetsByCategory(category) {
  return BACKUP_DATASETS.filter(d => d.category === category);
}
export function getDataset(key) {
  return BACKUP_DATASETS.find(d => d.key === key);
}
export function isScopable(ds) {
  return ds.scope !== "none";
}

const chunk = (arr, size = ID_CHUNK) => sharedChunk(arr, size);

/* --- counts -------------------------------------------------------------- */

async function countUnscoped(ds) {
  const { count, error } = await supabase.from(ds.table).select("*", { count: "exact", head: true });
  return error ? { count: null, error: error.message } : { count: count ?? 0, error: null };
}

async function countScoped(ds, { orderIds, dateFrom, dateTo }) {
  try {
    if (ds.scope === "byOrder" || ds.scope === "byOrderId") {
      if (!orderIds) return countUnscoped(ds);
      const col = ds.scope === "byOrderId" ? "id" : "order_id";
      let total = 0;
      for (const ids of chunk(orderIds, ID_CHUNK)) {
        const { count, error } = await supabase.from(ds.table).select("*", { count: "exact", head: true }).in(col, ids);
        if (error) return { count: null, error: error.message };
        total += count ?? 0;
      }
      return { count: total, error: null };
    }
    if (ds.scope && ds.scope.date && (dateFrom || dateTo)) {
      let q = supabase.from(ds.table).select("*", { count: "exact", head: true });
      if (dateFrom) q = q.gte(ds.scope.date, dateFrom);
      if (dateTo) q = q.lte(ds.scope.date, dateTo);
      const { count, error } = await q;
      if (error) return countUnscoped(ds);       // column may not exist in this deployment
      return { count: count ?? 0, error: null };
    }
    return countUnscoped(ds);
  } catch (e) {
    return { count: null, error: e.message };
  }
}

export async function countAll(keys, scope = {}) {
  const results = await Promise.all(keys.map(async k => {
    const ds = getDataset(k);
    if (!ds) return [k, { count: null, error: "unknown dataset" }];
    if (ds.scope === "composite") return [k, { count: scope.orderIds ? scope.orderIds.length : null, error: null, approximate: true }];
    const r = await countScoped(ds, scope);
    return [k, r];
  }));
  return Object.fromEntries(results);
}

/* --- paged fetching ------------------------------------------------------ */

async function fetchPaged(buildQuery, onPage) {
  const rows = [];
  let page = 0;
  const MAX_PAGES = 500;      // 500k rows — far beyond a realistic browser export
  while (page < MAX_PAGES) {
    const { data, error } = await buildQuery(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data || []));
    if (onPage) onPage(rows.length);
    if (!data || data.length < PAGE_SIZE) break;
    page++;
  }
  return rows;
}

export async function fetchDataset(key, scope = {}, onProgress) {
  const ds = getDataset(key);
  if (!ds) throw new Error(`Unknown dataset: ${key}`);
  const report = n => onProgress && onProgress(ds.label, n);

  // byOrder / byOrderId — chunked, then paged within each chunk.
  if ((ds.scope === "byOrder" || ds.scope === "byOrderId") && scope.orderIds) {
    const col = ds.scope === "byOrderId" ? "id" : "order_id";
    const all = [];
    for (const ids of chunk(scope.orderIds, ID_CHUNK)) {
      const part = await fetchPaged((from, to) => {
        let q = supabase.from(ds.table).select(ds.select).in(col, ids).range(from, to);
        if (ds.order) q = q.order(ds.order, { ascending: true, nullsFirst: false });
        return q;
      }, () => report(all.length));
      all.push(...part);
      report(all.length);
    }
    return all;
  }

  // date-scoped, or unscoped
  const useDate = ds.scope && ds.scope.date && (scope.dateFrom || scope.dateTo);
  try {
    return await fetchPaged((from, to) => {
      let q = supabase.from(ds.table).select(ds.select).range(from, to);
      if (useDate) {
        if (scope.dateFrom) q = q.gte(ds.scope.date, scope.dateFrom);
        if (scope.dateTo) q = q.lte(ds.scope.date, scope.dateTo);
      }
      if (ds.order) q = q.order(ds.order, { ascending: true, nullsFirst: false });
      return q;
    }, report);
  } catch (e) {
    if (!useDate) throw e;
    // The date column may not exist in this deployment — fall back to the
    // full table rather than failing the export, and say so in the manifest.
    const rows = await fetchPaged((from, to) => {
      let q = supabase.from(ds.table).select(ds.select).range(from, to);
      if (ds.order) q = q.order(ds.order, { ascending: true, nullsFirst: false });
      return q;
    }, report);
    rows.__scopeFallback = `Could not filter ${ds.table} by ${ds.scope.date} (${e.message}) — exported unfiltered.`;
    return rows;
  }
}

/* --- the composite, colour-level exports --------------------------------- */

/* One row per PO + Style + Colour: what a merchandiser actually wants in
   Excel. Quantity comes from the colour way itself (never the order total
   repeated on every colour — that exact bug was found and fixed once
   already), and shipped/balance are that colour's own. */
export function buildColourLevelRows(ds) {
  const rows = [];
  const shippedByOrderColour = new Map();
  for (const line of ds.shipmentLines) {
    const k = `${line.order_id}|${line.color_way_name || ""}`;
    shippedByOrderColour.set(k, (shippedByOrderColour.get(k) || 0) + (line.shipped_qty || 0));
  }

  for (const o of ds.orders) {
    const colours = ds.colorWaysByOrder.get(o.id) || [];
    const m = orderMetrics(o, ds.shipmentSummaryByOrder);
    const list = colours.length ? colours : [{ name: "", qty: o.qty }];
    for (const cw of list) {
      const shipped = shippedByOrderColour.get(`${o.id}|${cw.name || ""}`) || 0;
      const qty = cw.qty ?? 0;
      const fob = "fob" in o ? o.fob : null;
      rows.push({
        "PO Prefix": o.po_prefix, "PO Number": o.po_number, "PO": `${o.po_prefix}${o.po_number}`,
        "Delivery": o.delivery_sequence || 1,
        "Style": o.style, "Colour": cw.name || "(no colour way)",
        "Colour Qty": qty,
        "FOB": fob ?? "", "Colour Value": fob != null ? Number((qty * fob).toFixed(2)) : "",
        "Shipped Qty (this colour)": shipped, "Balance Qty (this colour)": qty - shipped,
        "Order Total Qty": m.orderedQty, "Order Shipped Qty": m.shippedQty, "Order Balance Qty": m.balanceQty,
        "Status": o.status, "Risk": o.risk || "",
        "Factory": o.factories?.name || "", "Factory Code": o.factory_code || "",
        "Merchandiser": o.profiles?.full_name || "",
        "Customer": o.customers?.name || "", "Label": o.labels?.name || "",
        "Product Group": o.product_groups?.name || "", "Division": o.divisions?.name || "",
        "Business Unit": o.business_units?.name || "", "Season": o.season || "",
        "Fabric Ref": o.fabric_ref || "",
        "Order Rcv Date": o.order_rcv_date || "", "ETD": o.etd || "", "Revised ETD": o.revised_etd || "",
        "Latest Actual ETD": ds.shipmentSummaryByOrder.get(o.id)?.latestActualEtd || "",
        "Latest CRD": ds.crdByOrder.get(o.id) || "",
        "Lead Time (days)": o.order_rcv_date && o.etd ? Math.round((new Date(o.etd) - new Date(o.order_rcv_date)) / 86400000) : "",
      });
    }
  }
  return rows;
}

/* One row per real shipment line, joined back to its order for identity. */
export function buildShipmentLineRows(ds) {
  return ds.shipmentLines.map(l => {
    const o = ds.orders.find(x => x.id === l.order_id);
    const h = l.shipments || {};
    return {
      "PO": o ? `${o.po_prefix}${o.po_number}` : "", "Delivery": o?.delivery_sequence || 1,
      "Style": o?.style || "", "Colour": l.color_way_name || "",
      "Shipped Qty": l.shipped_qty, "Unit Price": l.unit_price ?? "", "Shipment Value": l.shipment_value ?? "",
      "Invoice Number": h.invoice_number || "", "Invoice Date": h.invoice_date || "",
      "Booking Date": h.booking_date || "", "Actual ETD": h.actual_etd || "", "Actual ETA": h.actual_eta || "",
      "Vessel": h.vessel || "", "Destination Port": h.destination_port || "", "Ship Mode": h.ship_mode || "",
      "Consignee": h.consignee_name || "",
      "Factory": o?.factories?.name || "", "Merchandiser": o?.profiles?.full_name || "",
      "Customer": o?.customers?.name || "", "Label": o?.labels?.name || "",
      "Product Group": o?.product_groups?.name || "", "Season": o?.season || "",
      "Order Status": o?.status || "",
    };
  });
}

/* --- nested values -------------------------------------------------------- */
function flattenForSheet(row) {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    out[k] = (v !== null && typeof v === "object") ? JSON.stringify(v) : v;
  }
  return out;
}

/* --- the run -------------------------------------------------------------- */

export async function runExport(keys, { filters = null, onProgress } = {}) {
  const needsScope = keys.some(k => {
    const ds = getDataset(k);
    return ds && ds.scope !== "none";
  });

  let reportDs = null;
  let scope = { orderIds: null, dateFrom: filters?.dateFrom || null, dateTo: filters?.dateTo || null, applied: false };

  if (needsScope && filters) {
    if (onProgress) onProgress("Resolving the orders in scope", 0);
    reportDs = await buildReportDataset(filters);
    scope.orderIds = reportDs.orders.map(o => o.id);
    scope.applied = true;
  }

  const counts = await countAll(keys, scope);
  const datasets = [];

  for (const key of keys) {
    const ds = getDataset(key);
    let rows = [], error = null, note = null;

    try {
      if (ds.scope === "composite") {
        if (!reportDs) {
          if (onProgress) onProgress("Resolving the orders in scope", 0);
          reportDs = await buildReportDataset(filters || {});
          scope.orderIds = reportDs.orders.map(o => o.id);
          scope.applied = !!filters;
        }
        rows = key === "order_book_colour" ? buildColourLevelRows(reportDs) : buildShipmentLineRows(reportDs);
        note = key === "order_book_colour"
          ? `Built from ${reportDs.orders.length.toLocaleString()} orders in scope — one row per PO + style + colour.`
          : `Built from ${reportDs.shipmentLines.length.toLocaleString()} shipment lines for the orders in scope.`;
        if (onProgress) onProgress(ds.label, rows.length);
      } else {
        rows = await fetchDataset(key, scope, onProgress);
        if (rows.__scopeFallback) { note = rows.__scopeFallback; }
      }
    } catch (e) {
      error = e.message;
    }

    const expected = ds.scope === "composite" ? rows.length : (counts[key]?.count ?? null);
    datasets.push({
      key, label: ds.label, table: ds.table || "(composite)", category: ds.category,
      rows, rowCount: rows.length, expected,
      // A composite dataset is derived, not a table read, so "reconciled"
      // is not a meaningful claim for it — reported as such rather than a
      // green tick that means nothing.
      reconciled: ds.scope === "composite" ? null : (expected == null ? null : expected === rows.length),
      derived: ds.scope === "composite",
      scoped: ds.scope !== "none" && scope.applied,
      note, error: error || counts[key]?.error || null,
    });
  }

  return { datasets, scope, orderCount: scope.orderIds ? scope.orderIds.length : null };
}

export function toSheets(datasets) {
  return datasets.map(d => ({ name: d.label, rows: d.rows.map(flattenForSheet) }));
}

export function buildManifest(datasets, { org, user, periodLabel, filterLabels, scope } = {}) {
  return {
    export_type: "AI Merchandising ERP — data export",
    generated_at: new Date().toISOString(),
    generated_by: user?.full_name || null,
    generated_by_role: user?.role || null,
    organization: org?.company_name || null,
    branch: org?.branch || null,
    period: periodLabel || "All time",
    filters: filterLabels && filterLabels.length ? filterLabels : ["none — whole business"],
    orders_in_scope: scope?.orderIds ? scope.orderIds.length : null,
    scope_note: "Exported through the application API as the signed-in user. Row Level Security applies, so this contains exactly the rows that user may read — it is not a full database dump. When a period is applied, child tables (colour ways, milestones, CRD updates, shipment lines) are filtered by their parent orders, never by their own dates, so the export stays internally consistent.",
    datasets: datasets.map(d => ({
      key: d.key, table: d.table, label: d.label,
      rows_exported: d.rowCount,
      rows_in_database_visible_to_user: d.expected,
      period_scoped: d.scoped || false,
      derived: d.derived || false,
      reconciled: d.reconciled,
      note: d.note || undefined,
      error: d.error || undefined,
    })),
    total_rows_exported: datasets.reduce((s, d) => s + d.rowCount, 0),
  };
}

export function downloadJsonBackup(datasets, manifest, fileName) {
  const payload = { manifest, data: Object.fromEntries(datasets.map(d => [d.key, d.rows])) };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function estimateSize(datasets) {
  let bytes = 0;
  for (const d of datasets) {
    if (!d.rows.length) continue;
    const n = Math.min(20, d.rows.length);
    bytes += (JSON.stringify(d.rows.slice(0, n)).length / n) * d.rows.length;
  }
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
