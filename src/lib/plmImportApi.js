import * as XLSX from "xlsx";
import { supabase } from "./supabaseClient.js";

/* Core import engine, shared by Main PLM and Licensee -- both create
   records in the same standard orders/order_color_ways structure, per
   explicit instruction not to build a separate isolated system. Tested
   against a real 406-row, 167-column PLM export before being wired in
   here (see project history) -- header detection, column mapping, and
   row-level classification all confirmed correct against real data. */

const PLM_FIELD_ALIASES = {
  po_prefix: ["po prefix"],
  po_number: ["po #", "po#"],
  style: ["style#", "style #", "style"],
  color_way: ["color way", "colorway"],
  qty: ["ordered quantity", "ordered qty", "qty"],
  po_issue_date: ["po issue date"],
  division: ["division"],
  business_unit: ["bu #", "bu#", "business unit"],
  customer: ["customer name", "customer"],
  product_group: ["product group"],
  label: ["label"],
  season: ["season"],
  etd: ["latest required x-country ship date", "etd"],
  fabric_ref: ["fabric ref. #", "fabric ref#", "fabric ref"],
  unit_price: ["unit_price", "unit price", "fob"],
  merchandiser: ["bc status by", "merchandiser"],
};

// Licensee's own required set is smaller and explicit -- Division/Business
// Unit/Customer/Season are allowed blank per direct instruction. Color Way
// is optional too: a Licensee order without one still fits the shared
// PO -> Style -> Color Way structure using a single default color way,
// rather than needing a separate order shape. Flagging this design choice
// here rather than assuming it's obviously right.
const REQUIRED_FIELDS = {
  plm: ["po_prefix", "po_number", "style", "color_way", "qty"],
  licensee: ["po_prefix", "po_number", "style", "qty"],
};

function detectHeaderRow(rows) {
  const allAliases = Object.values(PLM_FIELD_ALIASES).flat();
  let bestRow = 0, bestScore = 0;
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const cells = (rows[r] || []).map(c => String(c ?? "").trim().toLowerCase());
    const score = allAliases.filter(alias => cells.includes(alias)).length;
    if (score > bestScore) { bestScore = score; bestRow = r; }
  }
  return { headerRowIndex: bestRow, score: bestScore };
}

function buildColumnMap(headerRow) {
  const cells = headerRow.map(c => String(c ?? "").trim().toLowerCase());
  const map = {};
  for (const [field, aliases] of Object.entries(PLM_FIELD_ALIASES)) {
    const idx = cells.findIndex(c => aliases.includes(c));
    if (idx !== -1) map[field] = idx;
  }
  return map;
}

function splitCodeName(raw) {
  if (!raw) return { code: null, name: null };
  const s = String(raw).trim();
  const dashIdx = s.indexOf(" - ");
  if (dashIdx === -1) return { code: null, name: s };
  return { code: s.slice(0, dashIdx).trim(), name: s.slice(dashIdx + 3).trim() };
}

function excelDateToISO(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    // Excel serial date
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return d.toISOString().slice(0, 10);
  }
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

// Step 1: look at the workbook's sheets, without parsing any data yet, so
// the UI can show the user what's there and require an explicit choice
// when there's more than one -- never silently combine or guess.
export async function inspectWorkbook(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheets = wb.SheetNames.map(name => {
    const ws = wb.Sheets[name];
    const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });
    const { headerRowIndex, score } = detectHeaderRow(allRows);
    return { name, headerRowIndex, matchScore: score, hasData: score > 0 };
  });
  // Default suggestion: the first sheet that actually looks like PLM data
  // (matched at least one known field), not just the first sheet in the
  // workbook -- a workbook's first tab is sometimes a cover sheet or
  // instructions, not the real data.
  const suggested = sheets.find(s => s.hasData)?.name || sheets[0]?.name;
  return { sheets, suggested, requiresSelection: sheets.length > 1 };
}

// Step 2: parse exactly the one sheet the user selected (or the only
// sheet, if there's just one) -- this never reads any other sheet in the
// workbook.
export async function parseSheet(file, source, sheetName) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error(`Sheet "${sheetName}" not found in this workbook.`);
  const allRows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });

  const { headerRowIndex, score } = detectHeaderRow(allRows);
  const columnMap = buildColumnMap(allRows[headerRowIndex]);
  const required = REQUIRED_FIELDS[source];
  const missingRequired = required.filter(f => !(f in columnMap));

  const dataRows = allRows.slice(headerRowIndex + 1);
  const parsed = [];
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    if (!row) continue;
    const get = (field) => columnMap[field] !== undefined ? row[columnMap[field]] : undefined;

    // A row with no PO Prefix, PO #, or Style at all isn't a real order
    // row -- skip it silently, regardless of stray artifact values
    // elsewhere in the row. Real exports routinely have thousands of
    // technically-non-blank trailing rows (a leftover "0" from a dragged
    // formula, a lingering cell format) well past the actual data --
    // requiring every single cell to be blank to skip a row is too
    // fragile for that; checking the identity fields specifically is not.
    const hasIdentity = [get("po_prefix"), get("po_number"), get("style")].some(v => v !== undefined && v !== null && v !== "");
    if (!hasIdentity) continue;

    const rawData = {};
    for (const field of Object.keys(PLM_FIELD_ALIASES)) {
      const v = get(field);
      if (v !== undefined && v !== null && v !== "") rawData[field] = v;
    }

    const errors = [];
    for (const f of required) {
      if (rawData[f] === undefined) errors.push(`${f.replace(/_/g, " ")} is required and was blank`);
    }
    if (rawData.qty !== undefined && (isNaN(Number(rawData.qty)) || Number(rawData.qty) <= 0)) {
      errors.push(`Qty must be a positive number, got "${rawData.qty}"`);
    }
    // Licensee: no Color Way column is fine -- default to a single implicit
    // color way so the shared PO -> Style -> Color Way structure still
    // applies underneath.
    if (source === "licensee" && !rawData.color_way) rawData.color_way = "DEFAULT";

    parsed.push({ sourceRowNumber: headerRowIndex + i + 2, rawData, errors });
  }

  return { sheetName, headerRowIndex, matchScore: score, columnMap, missingRequired, rows: parsed, totalDataRows: parsed.length };
}

async function loadMasterData() {
  const [customers, divisions, labels, businessUnits, productGroups, profiles] = await Promise.all([
    supabase.from("customers").select("code, name"),
    supabase.from("divisions").select("code, name"),
    supabase.from("labels").select("code, name"),
    supabase.from("business_units").select("code, name"),
    supabase.from("product_groups").select("code, name"),
    supabase.from("profiles").select("id, full_name"),
  ]);
  return {
    customers: customers.data || [], divisions: divisions.data || [], labels: labels.data || [],
    businessUnits: businessUnits.data || [], productGroups: productGroups.data || [], profiles: profiles.data || [],
  };
}

// Graceful, never-blocking match: try code, then name, then (for a bare
// value like Business Unit's "02") a code-prefix match. No match -> null +
// a warning note, not a hard error -- the order still imports and can be
// completed in the ERP later, same principle already used for other
// optional/ambiguous fields in this project.
function matchMasterData(rawValue, table, { allowPrefix = false, willAutoCreate = false } = {}) {
  if (!rawValue) return { code: null, warning: null };
  const { code, name } = splitCodeName(rawValue);
  if (code) {
    const byCode = table.find(t => t.code.toLowerCase() === code.toLowerCase());
    if (byCode) return { code: byCode.code, warning: null };
  }
  if (name) {
    const byName = table.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (byName) return { code: byName.code, warning: null };
  }
  const bareByCode = table.find(t => t.code.toLowerCase() === String(rawValue).toLowerCase());
  if (bareByCode) return { code: bareByCode.code, warning: null };
  if (allowPrefix) {
    const byPrefix = table.find(t => t.code.toLowerCase().startsWith(String(rawValue).toLowerCase() + "-"));
    if (byPrefix) return { code: byPrefix.code, warning: null };
  }
  const warning = willAutoCreate
    ? `"${rawValue}" is new -- will be added to master data automatically when you confirm this import`
    : `"${rawValue}" did not match any known master data -- left blank, complete later`;
  return { code: null, warning };
}

export async function classifyAndPreview(parsedRows) {
  const master = await loadMasterData();

  const validRows = parsedRows.filter(r => r.errors.length === 0);
  const orderKeys = [...new Set(validRows.map(r => `${r.rawData.po_prefix}|${r.rawData.po_number}|${r.rawData.style}`))];

  // Fetch existing orders + their color ways in bulk, not one query per row.
  const orConditions = orderKeys.map(k => {
    const [po_prefix, po_number, style] = k.split("|");
    return `and(po_prefix.eq.${po_prefix},po_number.eq.${po_number},style.eq.${style})`;
  });
  let existingOrders = [];
  if (orConditions.length) {
    const { data } = await supabase.from("orders").select("id, po_prefix, po_number, style").or(orConditions.join(","));
    existingOrders = data || [];
  }
  const orderIdByKey = new Map(existingOrders.map(o => [`${o.po_prefix}|${o.po_number}|${o.style}`, o.id]));

  let existingColorWays = [];
  if (existingOrders.length) {
    const { data } = await supabase.from("order_color_ways").select("order_id, name, qty").in("order_id", existingOrders.map(o => o.id));
    existingColorWays = data || [];
  }
  const cwQtyByKey = new Map();
  for (const cw of existingColorWays) {
    const order = existingOrders.find(o => o.id === cw.order_id);
    if (order) cwQtyByKey.set(`${order.po_prefix}|${order.po_number}|${order.style}|${cw.name}`, cw.qty);
  }

  const warnings = [];
  const classified = parsedRows.map(r => {
    if (r.errors.length > 0) return { ...r, classification: "error" };
    const orderKey = `${r.rawData.po_prefix}|${r.rawData.po_number}|${r.rawData.style}`;
    const cwKey = `${orderKey}|${r.rawData.color_way}`;
    let classification;
    if (!orderIdByKey.has(orderKey)) classification = "new";
    else if (!cwQtyByKey.has(cwKey)) classification = "new";
    else classification = cwQtyByKey.get(cwKey) === Number(r.rawData.qty) ? "duplicate" : "updated";

    const div = matchMasterData(r.rawData.division, master.divisions, { willAutoCreate: true });
    const cust = matchMasterData(r.rawData.customer, master.customers, { willAutoCreate: true });
    const label = matchMasterData(r.rawData.label, master.labels, { willAutoCreate: true });
    const bu = matchMasterData(r.rawData.business_unit, master.businessUnits, { allowPrefix: true });
    const pg = matchMasterData(r.rawData.product_group, master.productGroups, { willAutoCreate: true });
    const merch = r.rawData.merchandiser
      ? master.profiles.find(p => p.full_name.toLowerCase() === String(r.rawData.merchandiser).toLowerCase())
      : null;

    return { ...r, classification, matched: { division: div, customer: cust, label, businessUnit: bu, productGroup: pg, merchandiserId: merch?.id || null } };
  });

  return { rows: classified, existingOrdersMap: orderIdByKey };
}

export function groupByOrder(classifiedRows) {
  const groups = new Map();
  for (const r of classifiedRows) {
    if (r.classification === "error") continue;
    const key = `${r.rawData.po_prefix}|${r.rawData.po_number}|${r.rawData.style}`;
    if (!groups.has(key)) {
      groups.set(key, {
        po_prefix: r.rawData.po_prefix, po_number: String(r.rawData.po_number), style: r.rawData.style,
        colorWays: [], total_qty: 0, sample: r,
      });
    }
    const g = groups.get(key);
    g.colorWays.push({ color_way: r.rawData.color_way, qty: Number(r.rawData.qty) });
    g.total_qty += Number(r.rawData.qty);
  }
  return groups;
}

// The actual write. Never touches factory_code, primary_merchandiser_id is
// only SET (not overwritten) via merchandiser auto-match, status/risk/
// tna_remarks are never touched -- table defaults handle new rows, updates
// explicitly list only PLM-owned columns.
/* Auto-create master data that genuinely doesn't exist yet -- confirmed as
   an explicit, deliberate requirement: every field the PLM file provides
   should be captured directly from the file, not require a separate
   manual "+Add New" step afterward for values that are simply new (a new
   customer, division, label, or product group appearing for the first
   time). Scoped to exactly these four -- Business Unit stays match-only
   (a small, stable set, matched by bare-code/prefix already) and
   Merchandiser stays match-only (a real user account, not something to
   fabricate from PLM text).

   Deliberately only called from executeImport(), never from
   classifyAndPreview() -- the preview stage stays read-only with zero
   side effects; the "will be added automatically" language in the
   preview promises what confirming will do, not something that already
   happened just by looking. Respects RLS exactly as everywhere else in
   this app: the actual INSERT is gated by the same `system_settings`
   permission SelectWithAddNew already relies on for manual master-data
   additions -- if the importing user doesn't have it, this falls back to
   leaving the field blank with the existing warning, the same graceful
   degradation as before, not a bypass. */
async function ensureMasterDataExists(rawValue, table, cache) {
  if (!rawValue) return null;
  if (cache.has(rawValue)) return cache.get(rawValue);

  const { code, name } = splitCodeName(rawValue);
  const insertCode = (code || name || String(rawValue)).trim().toUpperCase().slice(0, 40);
  const insertName = (name || code || String(rawValue)).trim();

  const { error } = await supabase.from(table).insert({ code: insertCode, name: insertName }).select("code");
  // A conflict (someone else, or an earlier row in this same import,
  // already created this exact code) is expected and fine -- the row
  // exists either way, just re-fetch it rather than treating it as a
  // failure. Only an RLS-style permission block should fall through to
  // returning null (leaving the field blank, same as before).
  if (error && error.code !== "23505") {
    cache.set(rawValue, null);
    return null;
  }
  const { data: row } = await supabase.from(table).select("code").eq("code", insertCode).single();
  const result = row?.code || null;
  cache.set(rawValue, result);
  return result;
}

export async function executeImport(classifiedRows, source, fileName, cancelledRef) {
  const { data: { user } } = await supabase.auth.getUser();
  const groups = groupByOrder(classifiedRows);

  let newCount = 0, updatedCount = 0, duplicateCount = 0, wasCancelled = false, groupsProcessed = 0;
  const errorCount = classifiedRows.filter(r => r.classification === "error").length;
  const rowResults = [];
  const masterDataCache = new Map(); // rawValue -> resolved code, shared across every group in this one import run

  for (const [key, g] of groups) {
    // Checked once per order group (not per row) -- cheap, and there's no
    // safe way to "undo" a group already written via separate REST calls,
    // so cancellation stops forward progress rather than attempting a
    // rollback of what's already committed.
    if (cancelledRef?.current) { wasCancelled = true; break; }
    groupsProcessed++;
    const sample = g.sample;
    const m = sample.matched;
    // Auto-create master data the PLM file provided but that doesn't
    // exist yet -- confirmed as an explicit requirement: every field the
    // file supplies should be captured directly, not left for a manual
    // "+Add New" pass afterward. Only attempted when the original match
    // failed (m.xxx.code is null); an existing match is used as-is.
    const [divCode, custCode, labelCode, pgCode] = await Promise.all([
      m.division.code || ensureMasterDataExists(sample.rawData.division, "divisions", masterDataCache),
      m.customer.code || ensureMasterDataExists(sample.rawData.customer, "customers", masterDataCache),
      m.label.code || ensureMasterDataExists(sample.rawData.label, "labels", masterDataCache),
      m.productGroup.code || ensureMasterDataExists(sample.rawData.product_group, "product_groups", masterDataCache),
    ]);
    // Fields PLM/Licensee always owns, on both create and update -- these
    // describe WHAT the order is, not its execution state.
    const identityFields = {
      product_group_code: pgCode, label_code: labelCode,
      division_code: divCode, business_unit_code: m.businessUnit.code,
      customer_code: custCode, season: sample.rawData.season || null,
      fabric_ref: sample.rawData.fabric_ref || null, qty: g.total_qty,
    };
    // ETD and FOB are deliberately never set from PLM -- confirmed
    // explicitly: these get confirmed later, via Factory Assignment /
    // Edit Order, not pulled from the PLM file at all. This also means
    // the earlier re-import protection logic (only touching ETD/FOB on
    // unconfirmed orders) is no longer needed -- there's nothing to
    // protect when the import never writes these fields in the first
    // place.

    const { data: existing } = await supabase.from("orders")
      .select("id, factory_code").eq("po_prefix", g.po_prefix).eq("po_number", g.po_number).eq("style", g.style).maybeSingle();

    let orderId;
    if (existing) {
      orderId = existing.id;
      await supabase.from("orders").update(identityFields).eq("id", orderId);
    } else {
      const { data: created, error } = await supabase.from("orders").insert({
        po_prefix: g.po_prefix, po_number: g.po_number, style: g.style,
        order_rcv_date: excelDateToISO(sample.rawData.po_issue_date),
        primary_merchandiser_id: m.merchandiserId, ...identityFields,
      }).select("id").single();
      if (error) { rowResults.push({ row: sample, classification: "error", errorMessage: error.message }); continue; }
      orderId = created.id;
    }

    for (const cw of g.colorWays) {
      const { data: existingCw } = await supabase.from("order_color_ways").select("id").eq("order_id", orderId).eq("name", cw.color_way).maybeSingle();
      if (existingCw) await supabase.from("order_color_ways").update({ qty: cw.qty }).eq("id", existingCw.id);
      else await supabase.from("order_color_ways").insert({ order_id: orderId, name: cw.color_way, qty: cw.qty });
    }

    for (const r of classifiedRows.filter(row => `${row.rawData.po_prefix}|${row.rawData.po_number}|${row.rawData.style}` === key)) {
      if (r.classification === "new") newCount++;
      else if (r.classification === "updated") updatedCount++;
      else if (r.classification === "duplicate") duplicateCount++;
      rowResults.push({ row: r, classification: r.classification, matchedOrderId: orderId });
    }
  }

  for (const r of classifiedRows.filter(row => row.classification === "error")) {
    rowResults.push({ row: r, classification: "error", errorMessage: r.errors.join("; ") });
  }

  const { data: batch } = await supabase.from("import_batches").insert({
    source, file_name: fileName, uploaded_by: user.id, total_rows: classifiedRows.length,
    new_count: newCount, updated_count: updatedCount, duplicate_count: duplicateCount, error_count: errorCount,
    status: wasCancelled ? "cancelled" : "confirmed", confirmed_at: new Date().toISOString(),
  }).select("id").single();

  await supabase.from("import_batch_rows").insert(rowResults.map(rr => ({
    batch_id: batch.id, row_number: rr.row.sourceRowNumber, raw_data: rr.row.rawData,
    classification: rr.classification, error_message: rr.errorMessage || null, matched_order_id: rr.matchedOrderId || null,
  })));

  return { batchId: batch.id, newCount, updatedCount, duplicateCount, errorCount, wasCancelled, groupsProcessed, totalGroups: groups.size };
}

export async function listImportHistory() {
  const { data, error } = await supabase.from("import_batches").select("*, profiles!import_batches_uploaded_by_fkey(full_name)").order("uploaded_at", { ascending: false });
  if (error) throw error;
  return data;
}

/* Batch deletion -- the backend (Migration 17: preview_import_batch_deletion() /
   delete_import_batch()) has existed and been tested for a while, but had
   no UI calling it anywhere. Confirmed as a real, prioritized gap and
   built here. Requires Migration 17 to actually be applied to the live
   database -- these calls will fail with a clear "function does not
   exist" error until then. */
export async function previewImportBatchDeletion(batchId, force = false) {
  const { data, error } = await supabase.rpc("preview_import_batch_deletion", { p_batch_id: batchId, p_force: force });
  if (error) throw error;
  return data;
}

export async function deleteImportBatch(batchId, force = false) {
  const { data, error } = await supabase.rpc("delete_import_batch", { p_batch_id: batchId, p_force: force });
  if (error) throw error;
  return data;
}
