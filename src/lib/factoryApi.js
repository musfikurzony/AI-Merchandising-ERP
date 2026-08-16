import { supabase } from "./supabaseClient.js";

/* Every query here goes through factory_portal_orders -- never the base
   `orders` table -- since that view is the actual security boundary
   (column exclusion of FOB/remarks + row scoping to the caller's own
   factory). This file has no code path that could accidentally bypass it. */

// Mirrors visible_in_factory_portal()'s logic (06_factory_portal.sql).
// Deliberately NOT re-derived from scratch -- this is a direct, minimal
// port of that exact three-branch function, kept here only because
// PostgREST's query builder can't call a two-argument function inside a
// WHERE clause from the client, and wrapping it in a new SQL function
// just to avoid this would mean a migration for something this small.
// The retention THRESHOLD itself still comes from the database
// (system_settings), never hardcoded -- only the branching logic is
// mirrored, not the configurable value.
function isVisibleByRetention(status, invoicedAt, retentionMonths) {
  if (status === "cancelled") return false; // never active work for a factory
  if (status !== "shipped") return true;
  if (!invoicedAt) return true;
  const cutoff = new Date(invoicedAt);
  cutoff.setMonth(cutoff.getMonth() + retentionMonths);
  return new Date() < cutoff;
}

export async function getRetentionMonths() {
  const { data, error } = await supabase.from("system_settings").select("value").eq("key", "factory_portal_retention_months").single();
  if (error) throw error;
  return Number(data.value) || 3;
}

export async function listMyOrders() {
  const [ordersRes, retentionMonths] = await Promise.all([
    supabase.from("factory_portal_orders").select("*").order("etd"),
    getRetentionMonths(),
  ]);
  if (ordersRes.error) throw ordersRes.error;
  return ordersRes.data.filter(o => isVisibleByRetention(o.status, o.invoiced_at, retentionMonths));
}

// One insert per order -- exactly what the backend already expects (each
// selected PO gets its own crd_updates row, classified and notified
// independently). No batching/merging logic here to duplicate; this is a
// thin loop over the same single-row insert the CRD engine already knows
// how to handle.
export async function submitCrdUpdate(orderIds, newCrd, remarks) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in");

  const orders = await supabase.from("factory_portal_orders").select("id, etd").in("id", orderIds);
  if (orders.error) throw orders.error;

  const results = [];
  for (const order of orders.data) {
    const { error } = await supabase.from("crd_updates").insert({
      order_id: order.id,
      new_crd: newCrd,
      etd_at_time_of_update: order.etd,
      source: "portal",
      entered_by_user_id: user.id,
      remarks,
    });
    results.push({ orderId: order.id, error: error?.message || null });
  }
  return results;
}
