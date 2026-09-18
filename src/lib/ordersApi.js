import { supabase } from "../lib/supabaseClient.js";
import { hasPermission } from "../lib/permissions.js";
/* getOrderColorWaysForOrders() has called fetchAllByIds since v84 but the
   import was never added, so the Orders list threw "fetchAllByIds is not
   defined" the moment it tried to load colour ways. A bundler does not catch
   this: an undeclared identifier is only an error when the line actually
   runs. */
import { fetchAllByIds } from "./supabaseFetch.js";
import { byEffectiveEtd } from "./deliveryDate.js";
import { lensOrder, lensOrders, lensNested } from "./viewerLens.js";

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
  return lensOrders(data);
}

/* `etd_buffer_days` arrives with migration 39. Until that has run the column
   does not exist, and asking PostgREST for a column that is not there fails
   the WHOLE select — so Order Detail would go from "no buffer control" to
   "will not open at all", which is a far worse bug than the missing feature.

   So it is probed once and remembered. This is deliberately NOT a build flag
   or a setting somebody has to switch: the app asks the database what it
   actually has, gets it right either way, and starts working the moment the
   migration runs without anyone redeploying or toggling anything. The buffer
   is also kept OUT of BASE_SELECT for the same reason — the Orders list does
   not show it, so it has no business depending on it. */
let bufferColumnExists = null;     // null = not yet probed

function isMissingColumn(error, column) {
  const text = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`;
  return error?.code === "42703" || (text.includes(column) && /does not exist|could not find/i.test(text));
}

export async function getOrder(id) {
  const canFob = await canViewFob();
  const base = `${canFob ? `${BASE_SELECT}, fob` : BASE_SELECT}, tna_remarks`;

  if (bufferColumnExists !== false) {
    const { data, error } = await supabase.from("orders")
      .select(`${base}, etd_buffer_days`).eq("id", id).single();
    if (!error) { bufferColumnExists = true; return lensOrder(data); }
    if (!isMissingColumn(error, "etd_buffer_days")) throw error;
    bufferColumnExists = false;
  }

  const { data, error } = await supabase.from("orders").select(base).eq("id", id).single();
  if (error) throw error;
  return lensOrder(data);
}

/* True only once a successful read has proved the column is there. The Edit
   Order screen uses it to say whether the buffer is actually in force or
   merely stored — see lib/etdBuffer.js. */
export function etdBufferAvailable() { return bufferColumnExists === true; }

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

/* `order_color_ways.fob` arrives with migration 41. Same treatment as the ETD
   buffer in migration 39: the app asks the database what it actually has,
   rather than being gated on a version number or a flag somebody has to
   remember to switch. Until the column exists, the colour field is simply not
   offered and the style price is the only price. */
let colourFobColumnExists = null;

/* --------------------------------------------------------------------------
   Pricing: the PO's styles, and the colours under them.
   --------------------------------------------------------------------------
   The Orders Tracking sheet reads PO -> style -> colour -> qty -> FOB, and
   this is the query behind the panel that mirrors it. One PO can hold several
   styles at several prices, and seeing them on one screen is the difference
   between spotting that OGASE020 and OGASG059 are both showing 3.59 and not
   spotting it.

   FOB is fetched only when the caller may see it — the same `view_fob`
   permission that gates it everywhere else, checked here rather than trusted
   to the screen. */
export async function getPoPricing(poPrefix, poNumber) {
  const canFob = await canViewFob();
  const cols = `id, po_prefix, po_number, style, qty, etd, status${canFob ? ", fob" : ""}`;
  const { data: orders, error } = await supabase.from("orders")
    .select(cols)
    .eq("po_prefix", poPrefix).eq("po_number", poNumber).eq("is_deleted", false)
    .order("style");
  if (error) throw error;

  const ids = (orders || []).map(o => o.id);
  const byOrder = ids.length ? await getOrderColorWaysForOrders(ids) : new Map();

  /* Probe on the READ rather than waiting for a failed write. The colour rows
     come back with select("*"), so the column's presence is simply whether
     the key is on the row — no extra query, and the panel knows before it
     offers a field that cannot be saved. Only decided when there is at least
     one row to look at; an order with no colours says nothing either way. */
  for (const list of byOrder.values()) {
    if (list.length) { colourFobColumnExists = "fob" in list[0]; break; }
  }

  return { orders: lensOrders(orders || []), colorWaysByOrder: byOrder, canFob };
}

export function colourFobAvailable() { return colourFobColumnExists === true; }

/* A colour is identified within its order by NAME — that is what
   order_milestones already keys on (`color_way_name`), so using anything else
   here would mean two notions of which colour is which. */
export async function setColourFob(orderId, colourName, fob) {
  const value = fob === "" || fob === null || fob === undefined ? null : Number(fob);
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new Error("FOB must be a number, and not negative.");
  }
  const { data, error } = await supabase.from("order_color_ways")
    .update({ fob: value }).eq("order_id", orderId).eq("name", colourName)
    .select("order_id").single();
  if (error) {
    if (isMissingColumn(error, "fob")) {
      colourFobColumnExists = false;
      throw new Error("Colour-level FOB is not available yet — migration 41 has not been run on this database.");
    }
    throw new Error("Could not save the colour price -- you may not have edit access to this order.");
  }
  colourFobColumnExists = true;
  if (!data) throw new Error("That colour was not found on this order.");

  const { data: { user } } = await supabase.auth.getUser();
  await supabase.from("audit_log").insert({
    order_id: orderId, actor_id: user.id, action: "order.field_edited",
    field_name: `fob (${colourName})`, old_value: null,
    new_value: value === null ? "(uses style FOB)" : String(value),
  });
}

/* --------------------------------------------------------------------------
   Quantity, at the level it is actually decided.
   --------------------------------------------------------------------------
   "qty and price are now colour level, and should have update facility."

   That is right, and it matters more than the price did, because the two
   quantities have to AGREE. `orders.qty` is what every report, KPI,
   notification and value figure in the application reads; the colour rows are
   what the factory cuts and the shipping desk ships against. If a colour is
   edited and the style total is left alone, the two drift apart silently and
   every number downstream is quietly wrong — and nothing on any screen would
   say so.

   So this is ONE operation, not two: write the colour, re-sum the colours,
   write the style total. The style quantity stops being a figure anyone types
   and becomes a consequence of the colours — which is what it always was in
   reality. The Pricing tab shows it as derived rather than offering a box
   that would let somebody set it to something the colours contradict.

   The re-sum is done from the DATABASE's own rows after the write, not from
   whatever the browser was holding. Two people editing two colours of the
   same style a second apart would otherwise each write a total computed
   without the other's change, and the last one would win with a wrong
   number. */
export async function setColourQty(orderId, colourName, qty) {
  const value = qty === "" || qty === null || qty === undefined ? null : Number(qty);
  if (value === null || !Number.isFinite(value) || value < 0) {
    throw new Error("Quantity must be a number, and not negative.");
  }
  if (!Number.isInteger(value)) throw new Error("Quantity must be a whole number of pieces.");

  const { data: beforeRow } = await supabase.from("order_color_ways")
    .select("qty").eq("order_id", orderId).eq("name", colourName).maybeSingle();

  const { data, error } = await supabase.from("order_color_ways")
    .update({ qty: value }).eq("order_id", orderId).eq("name", colourName)
    .select("order_id").single();
  if (error || !data) {
    throw new Error("Could not save the colour quantity -- you may not have edit access to this order.");
  }

  const total = await resyncOrderQty(orderId);

  const { data: { user } } = await supabase.auth.getUser();
  await supabase.from("audit_log").insert({
    order_id: orderId, actor_id: user.id, action: "order.field_edited",
    field_name: `qty (${colourName})`,
    old_value: beforeRow?.qty != null ? String(beforeRow.qty) : null,
    new_value: String(value),
  });
  return { total };
}

/* Make the style total equal the sum of its colours. Returns the new total.

   Called after any colour quantity write. Deliberately re-reads the colour
   rows rather than trusting a number passed in — see setColourQty above. */
export async function resyncOrderQty(orderId) {
  const { data: colours, error } = await supabase.from("order_color_ways")
    .select("qty").eq("order_id", orderId);
  if (error) throw error;
  if (!colours || colours.length === 0) return null;   // no breakdown: the style total stands on its own

  const total = colours.reduce((s, c) => s + (Number(c.qty) || 0), 0);
  const { data: before } = await supabase.from("orders").select("qty").eq("id", orderId).single();
  if (Number(before?.qty) === total) return total;

  const { data, error: upErr } = await supabase.from("orders")
    .update({ qty: total }).eq("id", orderId).select("id").single();
  if (upErr || !data) {
    /* The colour saved and the total did not. Said out loud rather than
       swallowed: a style whose total disagrees with its colours is exactly
       the state this function exists to prevent, and a silent failure here
       would leave it that way with nothing on screen to show for it. */
    throw new Error("The colour was saved, but the style total could not be updated — the two now disagree. Ask an administrator to re-save this order.");
  }

  const { data: { user } } = await supabase.auth.getUser();
  await supabase.from("audit_log").insert({
    order_id: orderId, actor_id: user.id, action: "order.field_edited",
    field_name: "qty", old_value: before?.qty != null ? String(before.qty) : null,
    new_value: String(total),
  });
  return total;
}

/* The style total, for a style that has NO colour breakdown at all. There is
   nothing to derive it from in that case, so it is typed directly — and this
   refuses to run when colours exist, rather than letting a typed total
   contradict them. */
export async function setStyleQty(orderId, qty) {
  const value = qty === "" || qty === null || qty === undefined ? null : Number(qty);
  if (value === null || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error("Quantity must be a whole number of pieces, and not negative.");
  }
  const { data: colours } = await supabase.from("order_color_ways")
    .select("name").eq("order_id", orderId).limit(1);
  if (colours && colours.length) {
    throw new Error("This style has a colour breakdown — set the quantity on each colour and the total follows.");
  }

  const { data: before } = await supabase.from("orders").select("qty").eq("id", orderId).single();
  const { data, error } = await supabase.from("orders")
    .update({ qty: value }).eq("id", orderId).select("id").single();
  if (error || !data) throw new Error("Could not save the quantity -- you may not have edit access to this style.");

  const { data: { user } } = await supabase.auth.getUser();
  await supabase.from("audit_log").insert({
    order_id: orderId, actor_id: user.id, action: "order.field_edited",
    field_name: "qty", old_value: before?.qty != null ? String(before.qty) : null,
    new_value: String(value),
  });
}

/* The style's own price. Deliberately its own function rather than a trip
   through editOrder(): setting a price from the Pricing panel should not
   drag the whole Edit Order form's field set along with it, and — the part
   that matters — FOB must never be spread across the PO. It is a property of
   the style line, which is exactly what this report was about. */
export async function setStyleFob(orderId, fob) {
  const value = fob === "" || fob === null || fob === undefined ? null : Number(fob);
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new Error("FOB must be a number, and not negative.");
  }
  const { data: before } = await supabase.from("orders").select("fob").eq("id", orderId).single();
  const { data, error } = await supabase.from("orders")
    .update({ fob: value }).eq("id", orderId).select("id").single();
  if (error || !data) throw new Error("Could not save the price -- you may not have edit access to this style.");

  const { data: { user } } = await supabase.auth.getUser();
  await supabase.from("audit_log").insert({
    order_id: orderId, actor_id: user.id, action: "order.field_edited",
    field_name: "fob", old_value: before?.fob != null ? String(before.fob) : null,
    new_value: value === null ? null : String(value),
  });
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
  return lensOrders(data);
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
  return lensNested(latestPerOrder);
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
/* --------------------------------------------------------------------------
   Fields that belong to the PO, not to the style row that happens to store
   them.
   --------------------------------------------------------------------------
   The same reported bug as factory assignment, in two more places:

     primary_merchandiser_id — "Once any PO, our merchandiser name, that
       would go under PO. But currently see, it is under style." A PO is
       followed by one person. Storing that per style means a four-style PO
       needs the same name typed four times, and the first time one of them
       is missed the PO has two owners and the follow-up lists disagree
       about whose it is.

     etd_buffer_days — a buffer is a date shown to a factory, and a factory
       is booked per PO. A buffer on one style of a PO would show that
       factory two different delivery dates for one booking, which is worse
       than showing them the real one.

   Everything else stays per style, and deliberately so: qty, FOB, fabric
   reference, the ETD itself and its revision are genuinely properties of
   the style line, and quietly fanning those across a PO would overwrite
   real differences.

   Nothing new is invented here — this is assignFactory's precedent, which
   is already the right shape, applied to the other two fields that share
   its grain. No migration: the storage does not change, only how many rows
   one edit reaches. */
export const PO_WIDE_FIELDS = ["primary_merchandiser_id", "etd_buffer_days"];

/* --------------------------------------------------------------------------
   Dates belong to the PO too — but to the DELIVERY, not the whole PO blindly.
   --------------------------------------------------------------------------
   "ETD also I put but seeing ETD is not reflecting to all style, all colours,
   whereas this ETD is whole PO level, right… So each colour setting ETD is
   not wise."

   Right. A PO ships together; the delivery date is a fact about the PO, not
   about each style inside it. v95 left ETD per style on the reasoning that it
   is "genuinely a property of the style line", and that was wrong about this
   business.

   The one real exception is a SPLIT DELIVERY. `splitOrderDelivery()` exists
   and gives a PO more than one `delivery_sequence`, each with its own date —
   that is the whole point of splitting one. Spreading a date across the
   entire PO regardless would silently overwrite the second delivery's date
   with the first's, which is a worse bug than the one being fixed.

   So these spread across the same PO AND the same delivery sequence. An
   unsplit PO has one sequence, so in the ordinary case that is every style. */
export const DELIVERY_WIDE_FIELDS = ["etd", "revised_etd"];

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

  /* The shared fields, reconciled across the PO. Done AFTER the main write
     and reported separately: if this half fails, the edit the user made has
     still been saved, and they are told which styles were not reached rather
     than being shown one error for the whole save.

     ------------------------------------------------------------------------
     RECONCILED ON EVERY SAVE, NOT ONLY WHEN THE VALUE CHANGES
     ------------------------------------------------------------------------
     This used to spread a field only when it DIFFERED from `before` on the
     style being edited. That is the bug he hit: he set the merchandiser on
     OGASE020, and because that style already held the value by the time he
     saved, nothing was considered changed and the other five styles of
     RT5077 were never touched. The PO sat with one style named and five
     blank, and no screen said anything was wrong. Trying again later worked —
     which is the worst kind of bug, because it looks like it fixed itself.

     A shared field is not "a change to propagate", it is "a value the whole
     PO must agree on". So every save states the intended value and each
     sibling is compared against it. A sibling that already matches is left
     alone, so nothing lands in its Activity Log for nothing. */
  const poWide = {};
  for (const f of PO_WIDE_FIELDS) if (f in changes) poWide[f] = changes[f];
  const deliveryWide = {};
  for (const f of DELIVERY_WIDE_FIELDS) if (f in changes) deliveryWide[f] = changes[f];

  const results = [];
  if (Object.keys(poWide).length) {
    results.push(await spreadAcrossPo(orderId, poWide, user.id, { sameDeliveryOnly: false }));
  }
  if (Object.keys(deliveryWide).length) {
    results.push(await spreadAcrossPo(orderId, deliveryWide, user.id, { sameDeliveryOnly: true, reason: revisedEtdReason }));
  }
  if (!results.length) return { spread: null };
  return {
    spread: {
      updated: results.reduce((n, r) => n + r.updated, 0),
      blocked: results.reduce((n, r) => n + r.blocked, 0),
      total: Math.max(...results.map(r => r.total)),
      /* Which styles were actually touched, so the confirmation can name a
         number rather than a guess. A style reached by both spreads is one
         style, not two. */
      touched: [...new Set(results.flatMap(r => r.touched || []))].length,
    },
  };
}

/* Apply a set of fields to the other live styles of the same PO.

   Row by row with .select().single(), the same as assignFactory, because
   .update() with a filter reports success on zero rows when RLS blocks it —
   a silent partial write is precisely the failure this is meant to prevent.

   `sameDeliveryOnly` narrows the set to the same `delivery_sequence`, which is
   what the dates need: a split PO deliberately has more than one delivery,
   each with its own date, and spreading a date across all of them would
   overwrite the second delivery's commitment with the first's. */
async function spreadAcrossPo(orderId, fields, actorId, { sameDeliveryOnly = false, reason = null } = {}) {
  const { data: thisOrder, error: findErr } = await supabase.from("orders")
    .select("po_prefix, po_number, delivery_sequence").eq("id", orderId).single();
  /* Thrown, not swallowed. The old version returned zeros here and on the
     sibling query below, which is indistinguishable from "there was nothing
     to do" — so a PO could be left half-updated and the screen would say it
     had succeeded. */
  if (findErr || !thisOrder) throw new Error("Saved this style, but could not read the PO to apply the shared fields to the others.");

  /* Only the columns being written, plus id. The old version selected every
     PO-wide column whether it was being written or not, which meant the whole
     query failed — silently — on a database where one of them did not exist
     yet. A query should not depend on a column it has no interest in. */
  const cols = ["id", ...Object.keys(fields)].join(", ");
  let q = supabase.from("orders").select(cols)
    .eq("po_prefix", thisOrder.po_prefix).eq("po_number", thisOrder.po_number)
    .eq("is_deleted", false).neq("id", orderId);
  if (sameDeliveryOnly) {
    const seq = thisOrder.delivery_sequence ?? 1;
    q = q.or(`delivery_sequence.eq.${seq}${seq === 1 ? ",delivery_sequence.is.null" : ""}`);
  }
  const { data: siblings, error: sibErr } = await q;
  if (sibErr || !siblings) throw new Error("Saved this style, but could not list the other styles of this PO to apply the shared fields.");

  let updated = 0, blocked = 0;
  const touched = [];
  const audits = [];
  for (const sib of siblings) {
    /* Already correct? Leave it alone. Writing an identical value would put
       a meaningless line in that style's Activity Log every time anybody
       saved anything on any style of the PO. */
    const needed = {};
    for (const [k, v] of Object.entries(fields)) {
      if (String(sib[k] ?? "") !== String(v ?? "")) needed[k] = v;
    }
    if (Object.keys(needed).length === 0) continue;

    const { data: ok, error } = await supabase.from("orders").update(needed).eq("id", sib.id).select("id").single();
    if (error || !ok) { blocked++; continue; }
    updated++;
    touched.push(sib.id);
    for (const [k, v] of Object.entries(needed)) {
      audits.push({
        order_id: sib.id, actor_id: actorId, action: "order.field_edited",
        field_name: k, old_value: sib[k] != null ? String(sib[k]) : null,
        new_value: v != null ? String(v) : null,
      });
    }
    /* A revised ETD carries a reason, and the reason is the justification for
       THAT date change. If the date reaches five styles, so must the reason —
       otherwise four of them show a changed commitment with no explanation
       anywhere in their history. */
    if (reason && "revised_etd" in needed) {
      audits.push({
        order_id: sib.id, actor_id: actorId, action: "order.field_edited",
        field_name: "revised_etd_reason", old_value: null, new_value: reason,
      });
    }
  }
  if (audits.length) await supabase.from("audit_log").insert(audits);
  return { updated, total: siblings.length, blocked, touched };
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
  return lensOrders(combined).sort(byEffectiveEtd);
}

/* Managing who else (besides the primary merchandiser) can see and act on
   an order -- the UI side of order_permissions, which existed in the
   schema but had no way to grant/revoke it from anywhere in the app. */
/* --------------------------------------------------------------------------
   Sharing is a PO-level act, not a style-level one.
   --------------------------------------------------------------------------
   "If shared this PO to another merchandiser then also visible whole PO to
   their ERP dashboard or order or workbench etc, everywhere."

   `order_permissions` stores one row per ORDER ROW, which is one style. Share
   the style you happen to have open and the colleague sees one style of a
   six-style PO — on their Dashboard, in My Orders, in the Workbench,
   everywhere — and has no way of knowing the rest exists. That is not
   sharing a PO; it is sharing a fragment of one.

   The storage does not change. What changes is that one grant writes a row
   for every live style of the PO, and one revoke removes them all. */
async function poStyleIds(orderId) {
  const { data: o, error } = await supabase.from("orders")
    .select("po_prefix, po_number").eq("id", orderId).single();
  if (error || !o) throw new Error("Could not read this PO.");
  const { data: rows, error: e2 } = await supabase.from("orders")
    .select("id").eq("po_prefix", o.po_prefix).eq("po_number", o.po_number).eq("is_deleted", false);
  if (e2 || !rows) throw new Error("Could not list the styles of this PO.");
  return rows.map(r => r.id);
}

/* Who this PO is shared with. Grouped by person rather than listed once per
   style — six rows saying "Samir Sarkar" would be a list of the storage, not
   an answer to the question being asked. `styleCount` is carried so a share
   that only covers part of the PO (a grant made before v99) is visible as
   such rather than looking complete. */
export async function getOrderSharedUsers(orderId) {
  const ids = await poStyleIds(orderId);
  const { data, error } = await supabase.from("order_permissions")
    .select("id, order_id, user_id, granted_at, profiles!order_permissions_user_id_fkey(full_name)")
    .in("order_id", ids);
  if (error) throw error;

  const byUser = new Map();
  for (const row of data) {
    const entry = byUser.get(row.user_id) || {
      id: row.id, user_id: row.user_id, granted_at: row.granted_at,
      profiles: row.profiles, rowIds: [], styleCount: 0,
    };
    entry.rowIds.push(row.id);
    entry.styleCount += 1;
    if (row.granted_at && (!entry.granted_at || row.granted_at < entry.granted_at)) entry.granted_at = row.granted_at;
    byUser.set(row.user_id, entry);
  }
  const poStyles = ids.length;
  return [...byUser.values()].map(e => ({ ...e, poStyles, partial: e.styleCount < poStyles }));
}

export async function shareOrderWithUser(orderId, userId) {
  const { data: { user } } = await supabase.auth.getUser();
  const ids = await poStyleIds(orderId);

  /* Only the styles this person does not already have, so re-sharing a PO
     that was partly shared earlier completes it instead of failing on the
     rows that already exist. */
  const { data: existing } = await supabase.from("order_permissions")
    .select("order_id").eq("user_id", userId).in("order_id", ids);
  const have = new Set((existing || []).map(r => r.order_id));
  const missing = ids.filter(id => !have.has(id));
  if (!missing.length) return { added: 0, total: ids.length };

  const { error } = await supabase.from("order_permissions")
    .insert(missing.map(id => ({ order_id: id, user_id: userId, granted_by: user.id })));
  if (error) throw new Error("Could not share this PO -- you may not have permission to manage sharing on it.");
  return { added: missing.length, total: ids.length };
}

/* Takes the grouped entry, not a single row id: revoking a PO-level share has
   to remove every style's row, or the colleague keeps a partial PO and the
   list still shows them as shared. */
export async function revokeOrderShare(entry) {
  const rowIds = Array.isArray(entry?.rowIds) ? entry.rowIds : [entry?.id ?? entry].filter(Boolean);
  if (!rowIds.length) return;
  const { error } = await supabase.from("order_permissions").delete().in("id", rowIds);
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
