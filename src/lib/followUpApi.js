import { supabase } from "./supabaseClient.js";
import { getOrdersWithCrdAttention } from "./ordersApi.js";
export { getOrdersWithCrdAttention };

/* Follow-up Report -- Milestone 6. Reuses the existing CRD monitoring data
   (crd_updates, already live and tested since Phase 3) rather than
   inventing a parallel tracking mechanism. All "current CRD status"
   queries here use the same pattern already established for Dashboard's
   CRD Attention panel: fetch recent updates ordered by date, keep only the
   first (most recent) row per order -- correct because of the ordering,
   not a separate dedup pass that could drift out of sync with it. */

const ORDER_FIELDS = "po_prefix, po_number, style, etd, status, risk, factory_code, customer_code, primary_merchandiser_id, factories(name), customers(name), profiles!orders_primary_merchandiser_id_fkey(full_name)";

async function latestCrdPerOrder() {
  const { data, error } = await supabase.from("crd_updates")
    .select(`order_id, new_crd, classification, created_at, orders(${ORDER_FIELDS})`)
    .order("created_at", { ascending: false }).limit(500);
  if (error) throw error;
  const seen = new Set();
  const latest = [];
  for (const row of data) {
    if (seen.has(row.order_id)) continue;
    seen.add(row.order_id);
    if (row.orders && row.orders.status !== "shipped" && row.orders.status !== "cancelled") latest.push(row);
  }
  return latest;
}

export async function getOrdersApproachingCrd(daysAhead = 7) {
  const latest = await latestCrdPerOrder();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const horizon = new Date(today); horizon.setDate(horizon.getDate() + daysAhead);
  return latest.filter(r => {
    const crd = new Date(r.new_crd);
    return crd >= today && crd <= horizon;
  }).sort((a, b) => new Date(a.new_crd) - new Date(b.new_crd));
}

export async function getOrdersOverdueCrd() {
  const latest = await latestCrdPerOrder();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return latest.filter(r => new Date(r.new_crd) < today)
    .sort((a, b) => new Date(a.new_crd) - new Date(b.new_crd));
}

/* "No recent update" -- orders with no CRD entry at all in the last N
   days (including orders that have never had one). Needs the full open
   order list separately, since an order with zero crd_updates would never
   appear in the "latest per order" query above at all. */
export async function getOrdersNoRecentUpdate(daysThreshold = 14) {
  const [{ data: orders, error: oErr }, { data: recentCrd, error: cErr }] = await Promise.all([
    supabase.from("orders").select(`id, ${ORDER_FIELDS}`).not("status", "in", "(shipped,cancelled)").eq("is_deleted", false),
    supabase.from("crd_updates").select("order_id, created_at").order("created_at", { ascending: false }),
  ]);
  if (oErr) throw oErr;
  if (cErr) throw cErr;
  const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - daysThreshold);
  const lastUpdateByOrder = new Map();
  for (const c of recentCrd) {
    if (!lastUpdateByOrder.has(c.order_id)) lastUpdateByOrder.set(c.order_id, c.created_at);
  }
  return orders.filter(o => {
    const last = lastUpdateByOrder.get(o.id);
    return !last || new Date(last) < cutoff;
  });
}

/* Orders whose CRD has genuinely been revised more than once -- a real
   count of crd_updates rows per order, not an estimate. */
export async function getCrdRevisionCounts(minRevisions = 2) {
  const { data, error } = await supabase.from("crd_updates")
    .select(`order_id, new_crd, created_at, orders(${ORDER_FIELDS})`)
    .order("order_id");
  if (error) throw error;
  const counts = new Map();
  for (const row of data) {
    if (!counts.has(row.order_id)) counts.set(row.order_id, { order: row.orders, revisions: [] });
    counts.get(row.order_id).revisions.push({ new_crd: row.new_crd, created_at: row.created_at });
  }
  return [...counts.values()].filter(v => v.revisions.length >= minRevisions && v.order?.status !== "shipped" && v.order?.status !== "cancelled");
}

/* Grouped counts for the Factory-wise / Merchandiser-wise / Customer-wise
   breakdown -- computed from the same "orders needing attention" set
   (approaching + overdue + flagged), not a separate query per grouping. */
export function groupByDimension(rows, dimensionFn, labelFn) {
  const groups = new Map();
  for (const r of rows) {
    const key = dimensionFn(r) || "—";
    if (!groups.has(key)) groups.set(key, { label: labelFn(r) || key, count: 0 });
    groups.get(key).count++;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
