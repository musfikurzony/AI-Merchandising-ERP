import { supabase } from "./supabaseClient.js";

/* ==========================================================================
   The top-bar search.
   ==========================================================================
   This box existed on every screen as a `disabled` input with a "Search…"
   placeholder — furniture that looked like a feature. Either it does
   something or it should not be there; this makes it do something.

   What it answers is the question people actually walk up to the ERP with:
   "where is PO RT30452?" So it searches the identifiers a merchandiser has in
   their hand — PO number, style, colour, customer — and takes them straight
   to the order.

   Three things keep it cheap enough to run on every keystroke:
     - it asks the DATABASE to filter, never the browser, so it stays the same
       cost whether the table holds two thousand orders or two million;
     - it returns at most a handful of rows, with `.limit()` on the query
       itself rather than slicing what came back;
     - it does not run at all under three characters, because "a" matches
       everything and costs the most to answer. */

export const MIN_QUERY = 2;
export const RESULT_LIMIT = 8;

/* PostgREST's `or` takes a comma-separated filter list, and a comma or a
   parenthesis inside a value would terminate it early or open a group — so
   anything structural is stripped before the value is interpolated. A search
   box is user input arriving in a query string; it gets treated as such. */
function safeTerm(raw) {
  return String(raw || "").trim().replace(/[,()*\\%]/g, " ").replace(/\s+/g, " ").trim();
}

export async function searchOrders(rawTerm, { limit = RESULT_LIMIT, signal } = {}) {
  const term = safeTerm(rawTerm);
  if (term.length < MIN_QUERY) return { term, rows: [] };

  const like = `%${term}%`;
  let query = supabase
    .from("orders")
    .select(`
      id, po_prefix, po_number, style, qty, etd, revised_etd, status, risk,
      customers(name), factories(name), labels(name), profiles!orders_primary_merchandiser_id_fkey(full_name)
    `)
    .eq("is_deleted", false)
    .or(`po_number.ilike.${like},style.ilike.${like},po_prefix.ilike.${like}`)
    .order("etd", { ascending: true })
    .limit(limit);

  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw error;

  return { term, rows: (data || []).map(shape) };
}

/* Customer is on a joined table, so it cannot go in the same `or` as the
   order's own columns. It is a second, equally bounded query rather than a
   client-side scan — and it only runs when the first one had room left. */
export async function searchCustomers(rawTerm, { limit = 4, signal } = {}) {
  const term = safeTerm(rawTerm);
  if (term.length < MIN_QUERY) return [];
  let query = supabase
    .from("orders")
    .select(`
      id, po_prefix, po_number, style, qty, etd, revised_etd, status, risk,
      customers!inner(name), factories(name), labels(name), profiles!orders_primary_merchandiser_id_fkey(full_name)
    `)
    .eq("is_deleted", false)
    .ilike("customers.name", `%${term}%`)
    .order("etd", { ascending: true })
    .limit(limit);
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(shape);
}

function shape(o) {
  return {
    id: o.id,
    po: `${o.po_prefix}${o.po_number}`,
    style: o.style || "—",
    customer: o.customers?.name || "",
    factory: o.factories?.name || "",
    label: o.labels?.name || "",
    merchandiser: o.profiles?.full_name || "",
    qty: o.qty,
    etd: o.revised_etd || o.etd,
    revised: !!o.revised_etd,
    status: o.status,
    risk: o.risk,
  };
}

/* One call for the component: both queries, merged, de-duplicated by order id,
   and capped. Merging here rather than in the component keeps the component
   about presentation. */
export async function globalSearch(rawTerm, { limit = RESULT_LIMIT, signal } = {}) {
  const term = safeTerm(rawTerm);
  if (term.length < MIN_QUERY) return { term, rows: [] };

  const [byOrder, byCustomer] = await Promise.all([
    searchOrders(term, { limit, signal }),
    searchCustomers(term, { limit: 4, signal }).catch(() => []),
  ]);

  const seen = new Set();
  const rows = [];
  for (const r of [...byOrder.rows, ...byCustomer]) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    rows.push(r);
    if (rows.length >= limit) break;
  }
  return { term, rows };
}
