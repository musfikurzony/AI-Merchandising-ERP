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
  const rows = ordersRes.data.filter(o => isVisibleByRetention(o.status, o.invoiced_at, retentionMonths));
  return enrich(rows);
}

/* --------------------------------------------------------------------------
   Style, colour and merchandiser — which the view does not serve.
   --------------------------------------------------------------------------
   Opening a PO showed three columns: quantity, date, status. No style number,
   no colour. `factory_portal_orders` simply does not carry them, and the
   portal was written assuming it did, so those columns vanished rather than
   appearing empty — correct behaviour for the code, useless for the person.
   A factory books by PO and then works by style and colour; a PO you cannot
   open into its styles is a number, not a work list.

   The view stays the source of WHICH ROWS this factory may see — that is the
   part that must not be worked around, and nothing here widens it: every id
   used below came out of the view first. What is added is the descriptive
   detail for exactly those ids.

   Both fetches are allowed to fail. A factory account that cannot read
   `orders` at all is a perfectly reasonable configuration, and the right
   response to it is a portal with fewer columns, not an error page. Failure
   is silent by design, and `availableColumns()` on the screen then simply
   does not offer the column. */
async function enrich(rows) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id).filter(Boolean);
  if (!ids.length) return rows;

  const [detail, colours] = await Promise.all([
    chunked(ids, chunk => supabase.from("orders")
      .select("id, po_prefix, po_number, style, primary_merchandiser_id, profiles!orders_primary_merchandiser_id_fkey(full_name)")
      .in("id", chunk)),
    chunked(ids, chunk => supabase.from("order_color_ways")
      .select("order_id, name, qty").in("order_id", chunk)),
  ]);

  const byId = new Map((detail || []).map(d => [d.id, d]));
  const coloursByOrder = new Map();
  for (const c of colours || []) {
    if (!coloursByOrder.has(c.order_id)) coloursByOrder.set(c.order_id, []);
    coloursByOrder.get(c.order_id).push(c);
  }

  return rows.map(r => {
    const d = byId.get(r.id);
    const cw = coloursByOrder.get(r.id) || [];
    return {
      ...r,
      /* Only fill what is missing. If the view ever gains these columns, it
         wins — it is the narrower, deliberately-scoped source. */
      po_prefix: r.po_prefix ?? d?.po_prefix ?? null,
      po_number: r.po_number ?? d?.po_number ?? null,
      style: r.style ?? d?.style ?? null,
      merchandiser_name: r.merchandiser_name ?? d?.profiles?.full_name ?? null,
      /* A style row can span several colours. Kept as a list rather than
         flattened to one name: "BLACK, NAVY, KHAKI" in a Colour cell is a
         lie about the shape of the data, and the screen can expand it. */
      colour_ways: cw.map(c => ({ name: c.name, qty: c.qty })),
      color: r.color ?? (cw.length === 1 ? cw[0].name : null),
    };
  });
}

/* PostgREST puts .in() in the URL, so a long list is a request that never
   arrives. Same 150 ceiling the reporting fetches use. */
async function chunked(ids, run) {
  const out = [];
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await run(ids.slice(i, i + 150));
    if (error) return null;      // see enrich(): fewer columns, never an error page
    out.push(...(data || []));
  }
  return out;
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

/* Full CRD history for one order -- reuses crd_updates entirely (already
   has previous_crd, entered_by_name/entered_by_user_id, created_at, no
   new table). Resolves "who submitted it" to the factory's own name when
   the entry came from a real portal user (via their linked_factory_code),
   falling back to the free-text entered_by_name for CDS-API-sourced rows
   that have no user account behind them. */
export async function getCrdHistory(orderId) {
  const { data, error } = await supabase.from("crd_updates")
    .select("id, previous_crd, new_crd, source, entered_by_name, remarks, created_at, profiles!crd_updates_entered_by_user_id_fkey(full_name, linked_factory_code, factories(name))")
    .eq("order_id", orderId).order("created_at", { ascending: false });
  if (error) throw error;
  return data.map(row => ({
    ...row,
    submittedByLabel: row.profiles?.factories?.name || row.profiles?.full_name || row.entered_by_name || "—",
  }));
}
