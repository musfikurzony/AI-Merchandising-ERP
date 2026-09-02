import { supabase } from "./supabaseClient.js";
import { getFiscalYearRange, fiscalYearLabel, getFiscalYear } from "./reportsApi.js";

/* ==========================================================================
   Company growth — year over year.
   ==========================================================================
   This is the one part of the Dashboard that genuinely cannot be computed
   the way the rest is. Everything else works over the current period's
   orders, which a browser can hold. Growth asks about five or ten years at
   once, and pulling a decade of order lines into a tab to add up five
   numbers would be exactly the mistake the brief warns against.

   So the totals are computed IN THE DATABASE, by a view and an RPC added
   in migration 37, and this file only asks for them. One row per fiscal
   year comes back; no order rows travel at all.

   If the migration has not been run, this does not silently fall back to
   downloading years of data and it does not invent numbers. It falls back
   to COUNT-only queries, which are free of row transfer and can honestly
   answer "how many POs per year" while stating plainly that the quantity
   and value series need the migration. An empty chart with a reason beats
   a full chart with a lie. */

export const GROWTH_METRICS = [
  ["poCount", "PO count", "count"],
  ["orderQty", "Order quantity", "qty"],
  ["orderValue", "Order value", "money"],
  ["shippedQty", "Shipment quantity", "qty"],
  ["shippedValue", "Shipment value", "money"],
  ["customerCount", "Customers", "count"],
  ["factoryCount", "Factories", "count"],
  ["labelCount", "Labels", "count"],
];

export function fiscalYearSpan(endFy, back = 3) {
  const out = [];
  for (let i = back - 1; i >= 0; i--) out.push(endFy - i);
  return out;
}

/* The database path. One round trip, one row per fiscal year. */
async function viaRpc(fiscalYears) {
  const { data, error } = await supabase.rpc("dashboard_fy_growth", {
    p_from_fy: fiscalYears[0],
    p_to_fy: fiscalYears[fiscalYears.length - 1],
  });
  if (error) throw error;
  /* A deployment without migration 37 can answer the call without erroring
     — an unrelated function of the same name, or a stub — so the shape is
     checked, not assumed. Anything that is not a row set is treated as "not
     available", which routes to the honest COUNT fallback. */
  if (!Array.isArray(data)) throw new Error("dashboard_fy_growth did not return rows");
  return data.map(r => ({
    fiscalYear: Number(r.fiscal_year),
    label: fiscalYearLabel(Number(r.fiscal_year)),
    poCount: Number(r.po_count || 0),
    orderQty: Number(r.order_qty || 0),
    orderValue: Number(r.order_value || 0),
    shippedQty: Number(r.shipped_qty || 0),
    shippedValue: Number(r.shipped_value || 0),
    customerCount: Number(r.customer_count || 0),
    factoryCount: Number(r.factory_count || 0),
    labelCount: Number(r.label_count || 0),
  }));
}

/* The no-migration path. head:true means PostgREST returns the count in a
   header and no rows in the body — this is cheap at any table size, which
   is the whole reason it is an acceptable fallback. */
async function viaCounts(fiscalYears) {
  const rows = [];
  for (const fy of fiscalYears) {
    const { start, end } = getFiscalYearRange(fy);
    const { count, error } = await supabase
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("is_deleted", false)
      .neq("status", "cancelled")
      .gte("etd", start)
      .lte("etd", end);
    if (error) throw error;
    rows.push({
      fiscalYear: fy, label: fiscalYearLabel(fy),
      poCount: count || 0,
      orderQty: null, orderValue: null, shippedQty: null, shippedValue: null,
      customerCount: null, factoryCount: null, labelCount: null,
    });
  }
  return rows;
}

export async function loadGrowth({ endFy = getFiscalYear(new Date().toISOString().slice(0, 10)), back = 3 } = {}) {
  const years = fiscalYearSpan(endFy, back);
  try {
    const series = await viaRpc(years);
    return { series, source: "database", partial: false };
  } catch (e) {
    /* A missing function is the expected case before migration 37 is run;
       anything else is a real error worth surfacing. */
    const missing = /function .*dashboard_fy_growth|does not exist|PGRST202/i.test(e.message || "");
    try {
      const series = await viaCounts(years);
      return {
        series, source: "counts", partial: true,
        note: missing
          ? "Quantity and value series need migration 37 (dashboard_fy_growth). PO counts below are live and exact."
          : `Aggregate unavailable (${e.message}). PO counts below are live and exact.`,
      };
    } catch (e2) {
      return { series: [], source: "none", partial: true, note: e2.message };
    }
  }
}

/* Percentage growth against the previous fiscal year. Returns null rather
   than a number when the previous year holds nothing — "+100%" against a
   year with no orders is not growth, it is the first year of trading, and
   presenting it as growth would mislead. */
export function growthDeltas(series, metricKey) {
  return series.map((row, i) => {
    const prev = i > 0 ? series[i - 1] : null;
    const now = row[metricKey];
    const before = prev ? prev[metricKey] : null;
    const pct = (before && before > 0 && now != null) ? Math.round(((now - before) / before) * 1000) / 10 : null;
    return { ...row, value: now, prevValue: before, pct };
  });
}

export function hasAnyData(series) {
  return series.some(r => (r.poCount || 0) > 0);
}
