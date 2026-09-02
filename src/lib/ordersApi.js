import { supabase } from "../lib/supabaseClient.js";
import { hasPermission } from "../lib/permissions.js";
/* getOrderColorWaysForOrders() has called fetchAllByIds since v84 but the
   import was never added, so the Orders list threw "fetchAllByIds is not
   defined" the moment it tried to load colour ways. A bundler does not catch
   this: an undeclared identifier is only an error when the line actually
   runs. */
import { fetchAllByIds } from "./supabaseFetch.js";

/* Single shared query layer for orders -- per explicit instruction, "avoid
   duplicating order logic separately in every module." Dashboard, Orders,
   and (eventually) Workbench/Reports should all import from here rather
   than writing their own order queries. */

const BASE_SELECT = `
  id, po_prefix, po_number, style, season, qty, etd, revised_etd, order_rcv_date,
  status, risk, factory_code, primary_merchandiser_id, created_at, fabric_ref,
  customer_code, product_group_code, label_code, division_code, business_unit_code,
  delivery_sequence, split_from_order_id,
  product_groups(code, name), product_categories(name), labels(code, name),
  divisions(code, name), business_units(code, name), customers(code, name), factories(name),
  profiles!orders_primary_merchandiser_id_fkey(full_name)
`;

/* FOB is deliberately never in BASE_SELECT -- it's added only after an
   explicit permission check, so a caller can never accidentally leak it by
   forgetting a check. This mirrors exactly how the Factory Portal's view
   handles the same field, just enforced in this shared layer instead of a
   database view, since orders (unlike factory_portal_orders) is a real
   table multiple different screens read from with different field needs. */
export async function canViewFob() {
  try { return await hasPermission("view_fob"); }
  catch (e) { console.error("canViewFob check failed, defaulting to hidden:", e); return false; }
}

export async function listOrders(filters = {}) {
  const canFob = await canViewFob();
  let query = supabase.from("orders").select(canFob ? `${BASE_SELECT}, fob` : BASE_SELECT).eq("is_deleted", false);

  if (filters.customerCode) query = query.eq("customer_code", filters.customerCode);
  if (filters.labelCode) query = query.eq("label_code", filters.labelCode);
  if (filters.productGroupCode) query = query.eq("product_group_code", filters.productGroupCode);
  if (filters.factoryCode) query = query.eq("factory_code", filters.factoryCode);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.excludeStatus) query = query.neq("status", filters.excludeStatus);
  if (filters.risk) query = query.eq("risk", filters.risk);
  if (filters.etdFrom) query = query.gte("etd", filters.etdFrom);
  if (filters.etdTo) query = query.lte("etd", filters.etdTo);

  const { data, error } = await query.order("etd");
  if (error) throw error;
  return data;
}

export async function getOrder(id) {
  const canFob = await canViewFob();
  const { data, error } = await supabase.from("orders")
    .select(`${canFob ? `${BASE_SELECT}, fob` : BASE_SELECT}, tna_remarks`)
    .eq("id", id).single();
  if (error) throw error;
  return data;
}

export async function getOrderColorWays(orderId) {
  const { data, error } = await supabase.from("order_color_ways").select("*").eq("order_id", orderId).order("name");
  if (error) throw error;
  return data;
}

/* Same truncation class as the reporting fetches: this is called with every
   order id in a report, so both the row ceiling and the URL length limit
   apply. Routed through the shared paged/chunked helper — the Orders Excel
   export and the Shipping Invoice report both read colour quantities from
   here, and a short read would understate ordered quantity per colour. */
export async function getOrderColorWaysForOrders(orderIds) {
  if (!orderIds || !orderIds.length) return new Map();
  const data = await fetchAllByIds("order_color_ways", "*", "order_id", orderIds, { order: "order_id" });
  const byOrder = new Map();
  for (const cw of data) {
    if (!byOrder.has(cw.order_id)) byOrder.set(cw.order_id, []);
    byOrder.get(cw.order_id).push(cw);
  }
  return byOrder;
}

export async function getOrderSamples(orderId) {
  const { data, error } = await supabase.from("order_style_samples").select("*").eq("order_id", orderId);
  if (error) throw error;
  return data;
}


export async function getOrderCrdHistory(orderId) {
  const { data, error } = await supabase.from("crd_updates").select("*").eq("order_id", orderId).order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

/* Today's Actions data -- shared here (not written directly into
   DashboardLanding) so the Follow-up Report can reuse the same real
   queries later instead of a second implementation. */

export async function getOrdersNeedingFactory() {
  const { data, error } = await supabase.from("orders")
    .select("id, po_prefix, po_number, style, etd, customers(name)")
    .is("factory_code", null).eq("is_deleted", false).order("etd");
  if (error) throw error;
  return data;
}

/* "CRD attention" = orders whose MOST RECENT crd_updates entry is
   critical or warning. Supabase's client doesn't have a clean "latest row
   per group" query, so this fetches recent updates ordered by date and
   keeps only the first (most recent) row per order_id -- correct because
   of the ordering, not a separate dedup pass that could get out of sync
   with it. */
export async function getOrdersWithCrdAttention() {
  const { data, error } = await supabase.from("crd_updates")
    .select("order_id, classification, new_crd, created_at, orders(po_prefix, po_number, style, etd, status, risk, factory_code, customer_code, primary_merchandiser_id, factories(name), customers(name), profiles!orders_primary_merchandiser_id_fkey(full_name))")
    .order("created_at", { ascending: false }).limit(500);
  if (error) throw error;
  const seen = new Set();
  const latestPerOrder = [];
  for (const row of data) {
    if (seen.has(row.order_id)) continue;
    seen.add(row.order_id);
    if (row.classification === "critical" || row.classification === "warning") latestPerOrder.push(row);
  }
  return latestPerOrder;
}
export async function getFilterOptions() {
  const [customers, productGroups, factories, labels, divisions, businessUnits, merchandisers] = await Promise.all([
    supabase.from("customers").select("code, name").order("name"),
    supabase.from("product_groups").select("code, name").order("name"),
    supabase.from("factories").select("code, name").order("name"),
    supabase.from("labels").select("code, name").order("name"),
    supabase.from("divisions").select("code, name").order("name"),
    supabase.from("business_units").select("code, name").order("name"),
    supabase.from("profiles").select("id, full_name").in("role", ["merchandiser", "manager", "admin", "super_admin"]).order("full_name"),
  ]);
  return {
    customers: customers.data || [],
    productGroups: productGroups.data || [],
    factories: factories.data || [],
    labels: labels.data || [],
    divisions: divisions.data || [],
    businessUnits: businessUnits.data || [],
    merchandisers: merchandisers.data || [],
  };
}

/* Real factory assignment -- previously the app only ever displayed
   "Unassigned," this actually writes orders.factory_code and records the
   decision in audit_log, matching what the Activity Log tab reads.
   Factory is never touched by PLM import (confirmed repeatedly throughout
   this project) -- this is the one, deliberate place it gets set. */
export async function assignFactory(orderId, factoryCode) {
  const { data: { user } } = await supabase.auth.getUser();
  // A PO is the correct unit for factory assignment, not an individual
  // style row -- confirmed as a real, reported bug: assigning via one
  // style's Order Detail page only updated that one row, leaving every
  // other style under the same PO Prefix+PO# unassigned. Find every order
  // sharing the same PO first, then apply to all of them.
  const { data: thisOrder, error: findErr } = await supabase.from("orders").select("po_prefix, po_number").eq("id", orderId).single();
  if (findErr || !thisOrder) throw new Error("Order not found.");
  const { data: siblingOrders, error: sibErr } = await supabase.from("orders")
    .select("id, status").eq("po_prefix", thisOrder.po_prefix).eq("po_number", thisOrder.po_number).eq("is_deleted", false);
  if (sibErr) throw sibErr;

  const { data: factory } = await supabase.from("factories").select("name").eq("code", factoryCode).single();

  let updatedCount = 0;
  for (const sib of siblingOrders) {
    // Assigning a factory moves each style from Unassigned to Sourcing --
    // matching v13's behavior. Only applies from 'unassigned' specifically
    // -- never regresses a style that's already progressed further
    // (production/shipped) backward to sourcing.
    const updates = { factory_code: factoryCode };
    if (sib.status === "unassigned") updates.status = "sourcing";
    // Supabase's .update() does not error when RLS silently blocks the
    // write (0 rows affected) -- .select().single() forces a real,
    // catchable result per style rather than a silent partial failure.
    const { data: updated, error } = await supabase.from("orders").update(updates).eq("id", sib.id).select("id").single();
    if (!error && updated) {
      updatedCount++;
      await supabase.from("audit_log").insert({
        order_id: sib.id, actor_id: user.id, action: "order.factory_assigned",
        field_name: "factory_code", old_value: null, new_value: `${factoryCode} - ${factory?.name || ""}`,
      });
    }
  }
  if (updatedCount === 0) throw new Error("Could not assign factory -- you may not have edit access to any style under this PO.");
  return { updatedCount, totalStyles: siblingOrders.length };
}

export async function getAuditLog(orderId) {
  // audit_log has two foreign keys to profiles -- actor_id (who did it,
  // Migration 01) and target_user_id (Migration 12, for user-management
  // audit entries, unrelated to orders). PostgREST can't guess which one
  // is meant without being told explicitly -- this is exactly the
  // "more than one relationship was found" error, confirmed against the
  // real constraint names (audit_log_actor_id_fkey / audit_log_target_user_id_fkey).
  const { data, error } = await supabase.from("audit_log")
    .select("*, profiles!audit_log_actor_id_fkey(full_name)").eq("order_id", orderId).order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function getOrderMilestones(orderId) {
  const { data, error } = await supabase.from("order_milestones").select("*").eq("order_id", orderId);
  if (error) throw error;
  return data;
}

/* Ex-Factory specifically, bulk, for the Excel export -- one row per
   order since ex_factory is style-level, not color-level. */
export async function getExFactoryMilestonesForOrders(orderIds) {
  if (!orderIds.length) return new Map();
  const { data, error } = await supabase.from("order_milestones")
    .select("order_id, plan_date, actual_date, status, updated_at").eq("milestone_key", "ex_factory").in("order_id", orderIds);
  if (error) throw error;
  return new Map(data.map(m => [m.order_id, m]));
}

export async function getMilestoneTypesFull() {
  const { data, error } = await supabase.from("tna_milestone_types").select("*").eq("is_active", true).order("sequence_order");
  if (error) throw error;
  return data;
}

export async function saveMilestoneField(orderId, milestoneKey, colorWayName, fields) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("order_milestones")
    .upsert({ order_id: orderId, milestone_key: milestoneKey, color_way_name: colorWayName || "", ...fields, updated_by: user.id },
      { onConflict: "order_id,milestone_key,color_way_name" });
  if (error) throw error;
}

/* Real port of v13's EditOrderModal save behavior: "Changes are written to
   the Activity Log automatically, one line per changed field" -- computed
   here by comparing against the order as it was before the edit, not
   assumed. Respects the same edit_orders/has_order_access RLS boundary as
   everything else -- .select().single() forces a real error on a blocked
   write instead of a silent no-op, same fix as assignFactory. */
export async function editOrder(orderId, before, changes, revisedEtdReason) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data: updated, error } = await supabase.from("orders").update(changes).eq("id", orderId).select("id").single();
  if (error || !updated) throw new Error("Could not save changes -- you may not have edit access to this order.");

  const entries = Object.entries(changes)
    .filter(([field, value]) => String(before[field] ?? "") !== String(value ?? ""))
    .map(([field, value]) => ({
      order_id: orderId, actor_id: user.id, action: "order.field_edited",
      field_name: field, old_value: before[field] != null ? String(before[field]) : null, new_value: value != null ? String(value) : null,
    }));
  if (revisedEtdReason) {
    entries.push({ order_id: orderId, actor_id: user.id, action: "order.field_edited", field_name: "revised_etd_reason", old_value: null, new_value: revisedEtdReason });
  }
  if (entries.length) await supabase.from("audit_log").insert(entries);
}

/* Add a new master-data value (Customer, Product Group, Label, Division,
   Business Unit) directly from the Edit Order screen -- for when a
   genuinely new one shows up that isn't in the dropdown yet. Reuses the
   existing `system_settings` permission that already gates every master
   data write in this project (Migration 02) -- no new permission concept.
   If the current user doesn't have it, this throws a clear, real error
   (via the same .select().single() forced-error pattern used everywhere
   else) rather than failing silently or letting the write through. */
const MASTER_TABLES = ["customers", "product_groups", "labels", "divisions", "business_units", "factories"];
export async function addMasterDataValue(table, code, name) {
  if (!MASTER_TABLES.includes(table)) throw new Error("Not a valid master data table.");
  const { data, error } = await supabase.from(table).insert({ code: code.trim(), name: name.trim() }).select("code").single();
  if (error || !data) throw new Error("Could not add this -- you may not have permission to add new master data (ask an Admin to grant System Settings access, or to add it directly).");
  return data;
}

/* "My Orders" -- confirmed as a real gap: the Dashboard was calling
   listOrders({}) with no filter at all, so for Admin/Manager roles (who
   can see every order via RLS) it showed literally everything, not
   specifically their own. Scoped to two real cases: orders where the
   current user is the primary merchandiser, OR orders explicitly shared
   with them via `order_permissions` -- the existing many-to-many sharing
   table (Migration 01), already there for exactly this "a department has
   more than one merchandiser on an order" case, just never surfaced with
   a UI or used by this query before now. */
export async function getMyOrders() {
  const canFob = await canViewFob();
  const { data: { user } } = await supabase.auth.getUser();
  const select = canFob ? `${BASE_SELECT}, fob` : BASE_SELECT;

  const [primary, shared] = await Promise.all([
    supabase.from("orders").select(select).eq("primary_merchandiser_id", user.id).eq("is_deleted", false),
    supabase.from("order_permissions").select(`orders!inner(${select})`).eq("user_id", user.id),
  ]);
  if (primary.error) throw primary.error;
  if (shared.error) throw shared.error;

  const seen = new Set();
  const combined = [];
  for (const o of primary.data) { if (!seen.has(o.id)) { seen.add(o.id); combined.push(o); } }
  for (const row of shared.data) { const o = row.orders; if (o && !seen.has(o.id) && !o.is_deleted) { seen.add(o.id); combined.push(o); } }
  return combined.sort((a, b) => (a.etd || "").localeCompare(b.etd || ""));
}

/* Managing who else (besides the primary merchandiser) can see and act on
   an order -- the UI side of order_permissions, which existed in the
   schema but had no way to grant/revoke it from anywhere in the app. */
export async function getOrderSharedUsers(orderId) {
  const { data, error } = await supabase.from("order_permissions").select("id, user_id, granted_at, profiles!order_permissions_user_id_fkey(full_name)").eq("order_id", orderId);
  if (error) throw error;
  return data;
}

export async function shareOrderWithUser(orderId, userId) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("order_permissions").insert({ order_id: orderId, user_id: userId, granted_by: user.id });
  if (error) throw new Error("Could not share this order -- you may not have permission to manage sharing on it.");
}

export async function revokeOrderShare(permissionRowId) {
  const { error } = await supabase.from("order_permissions").delete().eq("id", permissionRowId);
  if (error) throw new Error("Could not remove this share.");
}

/* PO Cancellation -- requesting reuses the existing edit_orders +
   has_order_access() combination (same as editOrder/assignFactory);
   approving reuses the existing 'approve' module_permission on orders,
   already correctly seeded true for Manager/Admin and false for
   Merchandiser -- no new permission concept needed. po_cancellation_requests
   has two separate foreign keys to profiles (requested_by, reviewed_by) --
   checked the real constraint names before writing these embedded joins,
   the same ambiguity risk that broke audit_log and order_permissions
   earlier in this project. */
export async function requestPoCancellation(poPrefix, poNumber, reason) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase.from("po_cancellation_requests")
    .insert({ po_prefix: poPrefix, po_number: poNumber, requested_by: user.id, reason }).select("id").single();
  if (error) throw new Error("Could not submit the cancellation request -- you may not have edit access to this PO.");
  return data.id;
}

export async function getPoCancellationRequests(status) {
  let query = supabase.from("po_cancellation_requests")
    .select("*, requested_profile:profiles!po_cancellation_requests_requested_by_fkey(full_name), reviewed_profile:profiles!po_cancellation_requests_reviewed_by_fkey(full_name)")
    .order("created_at", { ascending: false });
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/* The approved cancellation record for one specific PO -- reuses
   po_cancellation_requests exactly as-is, no duplicate cancellation
   fields anywhere. Also returns how many styles the PO actually had at
   cancellation time, so the details view can state plainly that the
   whole PO was cancelled, not just the one style the user happened to
   click into. */
export async function getPoCancellationDetails(poPrefix, poNumber) {
  const [{ data: request, error: reqErr }, { data: styles, error: styleErr }] = await Promise.all([
    supabase.from("po_cancellation_requests")
      .select("*, requested_profile:profiles!po_cancellation_requests_requested_by_fkey(full_name), reviewed_profile:profiles!po_cancellation_requests_reviewed_by_fkey(full_name)")
      .eq("po_prefix", poPrefix).eq("po_number", poNumber).eq("status", "approved")
      .order("reviewed_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("orders").select("style").eq("po_prefix", poPrefix).eq("po_number", poNumber).eq("is_deleted", false),
  ]);
  if (reqErr) throw reqErr;
  if (styleErr) throw styleErr;
  return { request, styleCount: styles?.length || 0 };
}

export async function getPoCancellationRequestForPo(poPrefix, poNumber) {
  const { data, error } = await supabase.from("po_cancellation_requests")
    .select("*").eq("po_prefix", poPrefix).eq("po_number", poNumber).eq("status", "pending").maybeSingle();
  if (error) throw error;
  return data;
}

export async function approvePoCancellation(requestId, reviewNote) {
  const { data, error } = await supabase.rpc("approve_po_cancellation", { p_request_id: requestId, p_review_note: reviewNote || null });
  if (error) throw error;
  return data;
}

export async function rejectPoCancellation(requestId, reviewNote) {
  const { data, error } = await supabase.rpc("reject_po_cancellation", { p_request_id: requestId, p_review_note: reviewNote || null });
  if (error) throw error;
  return data;
}

/* Creates a new "Delivery N" order for the remaining balance when a
   short shipment is a genuine future delivery, not a permanent
   shortfall -- confirmed design: same PO/style, its own ETD/status/
   Ex-Factory timeline from here, sample approvals carried forward so
   nobody re-does already-approved work. colorBalances is a plain object,
   e.g. { "MAIN": 10 }. Returns the new order's id. */
export async function splitOrderDelivery(orderId, colorBalances) {
  const { data, error } = await supabase.rpc("split_order_delivery", { p_order_id: orderId, p_color_balances: colorBalances });
  if (error) throw error;
  return data;
}
