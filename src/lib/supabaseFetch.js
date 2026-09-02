import { supabase } from "./supabaseClient.js";

/* Safe fetching for a database that will outgrow the browser.

   Two failure modes this module exists to prevent, both of which fail
   SILENTLY rather than loudly — which is what makes them dangerous:

   1. **The row cap.** PostgREST returns at most `db-max-rows` per request
      (Supabase's default is 1,000). A plain `.select()` does not error when
      it hits that ceiling; the array simply stops. A report reading 3,000
      milestone rows gets 1,000 of them and computes confidently wrong
      numbers — and a milestone row that never arrived is indistinguishable
      from one that was never entered.

   2. **The URL limit.** `.in("order_id", [...])` puts every id in the query
      string. Past a few thousand ids the request exceeds the server's URL
      length limit and fails outright (HTTP 414) — the failure is loud, but
      it arrives only once the business has grown, i.e. at the worst moment.

   The fix for both is the pattern already proven in `backupApi.js`, which
   has been generalised here so every caller shares one implementation:
   page with `.range()` until a short page comes back, and chunk id lists.

   Everything here also RECONCILES: the number of rows fetched is compared
   against an exact `COUNT` taken separately, and a mismatch is reported to
   the caller rather than swallowed. A number that might be wrong should say
   so on screen. */

export const PAGE_SIZE = 1000;   // matches PostgREST's default ceiling
export const ID_CHUNK = 150;     // keeps `in.(...)` comfortably inside URL limits

export function chunk(arr, size = ID_CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* Pages until a short page comes back. `buildQuery(from, to)` must return a
   fresh PostgREST query each call — reusing one builder across pages is a
   subtle bug, since the client mutates it. */
export async function fetchAllPaged(buildQuery, { onProgress, maxPages = 500 } = {}) {
  const rows = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await buildQuery(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const batch = data || [];
    rows.push(...batch);
    if (onProgress) onProgress(rows.length);
    // A short page means the server had nothing more to give. A full page
    // means there may be more, EVEN IF the caller expected fewer — that is
    // precisely the case the old code got wrong.
    if (batch.length < PAGE_SIZE) return rows;
  }
  throw new Error(`Refusing to page beyond ${maxPages * PAGE_SIZE} rows — narrow the filters or aggregate in the database instead.`);
}

/* Chunked id lookup, paged within each chunk. */
export async function fetchAllByIds(table, select, column, ids, { order, onProgress } = {}) {
  if (!ids || !ids.length) return [];
  const out = [];
  for (const part of chunk(ids)) {
    const rows = await fetchAllPaged((from, to) => {
      let q = supabase.from(table).select(select).in(column, part).range(from, to);
      if (order) q = q.order(order, { ascending: true, nullsFirst: false });
      return q;
    }, { onProgress: () => onProgress && onProgress(out.length) });
    out.push(...rows);
    if (onProgress) onProgress(out.length);
  }
  return out;
}

/* An exact count, asked for separately from the data. `head: true` means the
   database counts server-side and sends no rows — this is what keeps a
   headline figure cheap at any table size. */
export async function countRows(table, applyFilters) {
  let q = supabase.from(table).select("*", { count: "exact", head: true });
  if (applyFilters) q = applyFilters(q);
  const { count, error } = await q;
  if (error) return { count: null, error: error.message };
  return { count: count ?? 0, error: null };
}

export async function countByIds(table, column, ids, applyFilters) {
  if (!ids || !ids.length) return { count: 0, error: null };
  let total = 0;
  for (const part of chunk(ids)) {
    let q = supabase.from(table).select("*", { count: "exact", head: true }).in(column, part);
    if (applyFilters) q = applyFilters(q);
    const { count, error } = await q;
    if (error) return { count: null, error: error.message };
    total += count ?? 0;
  }
  return { count: total, error: null };
}

/* One reconciliation record per dataset. `ok: null` means the count could
   not be taken (a permission or transport problem) — reported as unknown,
   never assumed fine. */
export function reconcile(label, fetched, expected, error = null) {
  return {
    label,
    fetched,
    expected,
    ok: error ? false : expected == null ? null : expected === fetched,
    error,
  };
}

export function integrityOf(checks) {
  const list = checks.filter(Boolean);
  return {
    checks: list,
    ok: list.every(c => c.ok === true),
    unknown: list.some(c => c.ok === null),
    failures: list.filter(c => c.ok === false),
  };
}
