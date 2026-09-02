import { supabase } from "./supabaseClient.js";

/* Shipping Portal data layer, Step 2 of the approved order_shipments
   retirement. Shipped quantity and balance are always computed by
   summing shipment_lines, never stored as a separate maintained total --
   a stored total would drift the moment a later partial shipment gets
   added, confirmed as the whole reason for this two-table design. */

export async function listShipments(filters = {}) {
  let query = supabase.from("shipments").select("*, profiles!shipments_created_by_fkey(full_name)").order("booking_date", { ascending: false });
  if (filters.dateFrom) query = query.gte("booking_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("booking_date", filters.dateTo);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export async function getShipment(id) {
  const { data, error } = await supabase.from("shipments").select("*, profiles!shipments_unlocked_by_fkey(full_name)").eq("id", id).single();
  if (error) throw error;
  return data;
}

export async function createShipment(fields) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase.from("shipments").insert({ ...fields, created_by: user.id }).select("id").single();
  if (error) throw error;
  return data.id;
}

export async function updateShipment(id, fields) {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("shipments").update({ ...fields, updated_by: user.id, updated_at: new Date().toISOString() }).eq("id", id);
  if (error) throw error;
}

/* Every line for a given shipment header, across however many orders and
   colors it carries -- one shipment can legitimately span multiple
   styles/orders and multiple colors within each. */
export async function getShipmentLines(shipmentId) {
  const { data, error } = await supabase.from("shipment_lines")
    .select("*, orders(po_prefix, po_number, style)").eq("shipment_id", shipmentId).order("created_at");
  if (error) throw error;
  return data;
}

export async function addShipmentLine(shipmentId, orderId, colorWayName, shippedQty, unitPrice, remarks) {
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase.from("shipment_lines").insert({
    shipment_id: shipmentId, order_id: orderId, color_way_name: colorWayName || "",
    shipped_qty: shippedQty, unit_price: unitPrice, remarks: remarks || null, created_by: user.id,
  }).select("id").single();
  if (error) throw error;
  return data.id;
}

export async function deleteShipmentLine(lineId) {
  const { error } = await supabase.from("shipment_lines").delete().eq("id", lineId);
  if (error) throw error;
}

/* Editing an existing line -- shipped_qty and unit_price only, matching
   what's actually meant to change after the fact. shipment_value recomputes
   automatically (generated column), so nothing else needs touching.
   Governed by the exact same shipment_lines_write RLS policy as
   add/delete -- locked shipments are rejected at the database level here
   too, not just hidden in the UI. */
export async function updateShipmentLine(lineId, shippedQty, unitPrice) {
  const { error } = await supabase.from("shipment_lines").update({ shipped_qty: shippedQty, unit_price: unitPrice }).eq("id", lineId);
  if (error) throw error;
}

/* Every shipment line for one order, across every shipment it's ever been
   part of -- what Order Detail's Shipment tab needs to show each partial
   shipment as its own row, not combined into one total. */
export async function getShipmentLinesForOrder(orderId) {
  const { data, error } = await supabase.from("shipment_lines")
    .select("*, shipments(booking_date, vessel, actual_etd, actual_eta, destination_port, invoice_number)")
    .eq("order_id", orderId).order("created_at");
  if (error) throw error;
  return data;
}

/* Shipped qty / balance per color for one order -- ordered qty from
   order_color_ways, shipped qty summed fresh from shipment_lines every
   time, never a stored value. Unshipped colors still appear (qty=0, full
   balance), matching the explicit requirement. */
export async function getShipmentSummaryForOrder(orderId, colorWays) {
  const { data: lines, error } = await supabase.from("shipment_lines").select("color_way_name, shipped_qty").eq("order_id", orderId);
  if (error) throw error;
  const shippedByColor = new Map();
  for (const l of lines) shippedByColor.set(l.color_way_name, (shippedByColor.get(l.color_way_name) || 0) + l.shipped_qty);
  return colorWays.map(cw => {
    const shipped = shippedByColor.get(cw.name) || 0;
    return { color: cw.name, orderedQty: cw.qty, shippedQty: shipped, balance: cw.qty - shipped, shipmentCount: lines.filter(l => l.color_way_name === cw.name).length };
  });
}

/* Bulk fetch for many orders at once -- used by kpiApi.js and the Excel
   export, where fetching per-order in a loop would be far too many round
   trips. Returns a Map keyed by order_id, each value the array of that
   order's lines (with shipment header info embedded), so callers can
   aggregate however they need (total shipped, latest actual_etd, etc.)
   without a second query. */
export async function getShipmentLinesForOrders(orderIds) {
  if (!orderIds.length) return new Map();
  const { data, error } = await supabase.from("shipment_lines")
    .select("order_id, color_way_name, shipped_qty, shipment_value, shipments(vessel, booking_date, actual_etd, actual_eta, destination_port, invoice_number, invoice_date)")
    .in("order_id", orderIds);
  if (error) throw error;
  const byOrder = new Map();
  for (const l of data) {
    if (!byOrder.has(l.order_id)) byOrder.set(l.order_id, []);
    byOrder.get(l.order_id).push(l);
  }
  return byOrder;
}

/* Locking -- enforced at the RLS level (Migration 28), not just hidden in
   the UI. Once locked, shipment_lines writes for this shipment are
   rejected by the database regardless of what the client attempts.
   Unlocking requires Manager/Admin and a real reason -- both checked
   server-side too, so this isn't a UI-only guard. */
export async function lockShipment(shipmentId) {
  const { data, error } = await supabase.rpc("lock_shipment", { p_shipment_id: shipmentId });
  if (error) throw error;
  return data;
}

export async function unlockShipment(shipmentId, reason) {
  const { data, error } = await supabase.rpc("unlock_shipment", { p_shipment_id: shipmentId, p_reason: reason });
  if (error) throw error;
  return data;
}

/* Line count + total value per shipment, in one bulk query -- so the
   Shipments list can show at a glance which ones actually have real data
   entered ("3 lines, $12,450") vs. which are still empty, without an N+1
   query per row. */
export async function getShipmentLineTotals(shipmentIds) {
  if (!shipmentIds.length) return new Map();
  const { data, error } = await supabase.from("shipment_lines").select("shipment_id, shipped_qty, shipment_value").in("shipment_id", shipmentIds);
  if (error) throw error;
  const totals = new Map();
  for (const l of data) {
    const t = totals.get(l.shipment_id) || { lineCount: 0, totalQty: 0, totalValue: 0 };
    t.lineCount += 1; t.totalQty += l.shipped_qty; t.totalValue += l.shipment_value || 0;
    totals.set(l.shipment_id, t);
  }
  return totals;
}
