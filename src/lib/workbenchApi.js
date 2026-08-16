import { supabase } from "../lib/supabaseClient.js";
import { canViewFob } from "./ordersApi.js";

/* Real data layer behind the v13-faithful Workbench UI. The milestone
   catalog (MILESTONE_COLS in the prototype) now lives in the database as
   `tna_milestone_types` -- fetched once, not hardcoded -- so the grid
   renders generically from real catalog data exactly the way v13 rendered
   generically from its JS constant. */

export async function getMilestoneTypes() {
  const { data, error } = await supabase.from("tna_milestone_types").select("*").eq("is_active", true).order("sequence_order");
  if (error) throw error;
  return data;
}

/* One order per row here (not per color way -- that grouping happens in
   the component, same division of labor as v13's buildColorRows(), which
   took whole orders and expanded them into color rows itself). */
export async function listWorkbenchOrders() {
  const canFob = await canViewFob();
  const fobSelect = canFob ? ", fob" : "";
  const { data, error } = await supabase.from("orders")
    .select(`
      id, po_prefix, po_number, style, qty, etd, revised_etd, status, risk, factory_code${fobSelect},
      customers(name), product_groups(name), factories(name), profiles!orders_primary_merchandiser_id_fkey(full_name),
      labels(code, name), business_units(code, name)
    `)
    .not("factory_code", "is", null) // v13's Workbench (and Follow-up Report) only ever show orders with a factory assigned
    .neq("status", "cancelled") // Workbench and Follow-up Report are active work queues -- cancelled orders are excluded, but stay fully intact for reporting elsewhere
    .eq("is_deleted", false);
  if (error) throw error;
  return data;
}

export async function listColorWays(orderIds) {
  if (!orderIds.length) return [];
  const { data, error } = await supabase.from("order_color_ways").select("order_id, name, qty").in("order_id", orderIds);
  if (error) throw error;
  return data;
}

export async function listMilestones(orderIds) {
  if (!orderIds.length) return [];
  const { data, error } = await supabase.from("order_milestones").select("*").in("order_id", orderIds);
  if (error) throw error;
  return data;
}

/* Batch save -- v13's dirty-tracking `edits` state, translated into real
   upserts. `edits` is keyed by orderId, then by "milestoneKey" or
   "milestoneKey::colorWayName" for color-level milestones (Lab Dip,
   Strike-off, Fabric ETD, Fabric In-house, PP, TOP -- confirmed against
   the real Sample Tracking tab, which shows different status per color
   way, not one shared value per order). One upsert per (order, milestone,
   color way) actually touched -- not a blind rewrite of everything in the
   grid. */
export async function saveMilestoneEdits(edits) {
  const { data: { user } } = await supabase.auth.getUser();
  const rows = [];
  for (const [orderId, milestones] of Object.entries(edits)) {
    for (const [compoundKey, fields] of Object.entries(milestones)) {
      const [milestoneKey, colorWayName] = compoundKey.split("::");
      rows.push({ order_id: orderId, milestone_key: milestoneKey, color_way_name: colorWayName || "", ...fields, updated_by: user.id });
    }
  }
  if (!rows.length) return;
  const { error } = await supabase.from("order_milestones").upsert(rows, { onConflict: "order_id,milestone_key,color_way_name" });
  if (error) throw error;
}

/* Per-user Workbench column visibility, persisted -- not reset every
   login. Fetched/saved directly here rather than folded into the global
   session profile load, since it's only ever needed on this one screen. */
export async function getColumnPrefs() {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase.from("profiles").select("workbench_column_prefs").eq("id", user.id).single();
  if (error) throw error;
  return data.workbench_column_prefs || null;
}

export async function saveColumnPrefs(prefs) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("profiles").update({ workbench_column_prefs: prefs }).eq("id", user.id);
  if (error) throw error;
}

/* Follow-up Report's own persisted column preference -- deliberately
   separate from the Workbench's (confirmed against v13's real source:
   the printable report uses a leaner, curated default set for a readable
   printed page, not the Workbench's own defaults). Same mechanism, same
   RLS policy already covers it. */
export async function getFollowUpColumnPrefs() {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase.from("profiles").select("followup_column_prefs").eq("id", user.id).single();
  if (error) throw error;
  return data.followup_column_prefs || null;
}

export async function saveFollowUpColumnPrefs(prefs) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("profiles").update({ followup_column_prefs: prefs }).eq("id", user.id);
  if (error) throw error;
}
