/* ==========================================================================
   The factory portal, grouped the way a factory actually books work.
   ==========================================================================
   The report: "Factory portal should be PO label. But currently can see
   style label. Because factory will book based on PO. And one PO contains
   multiple styles, multiple colours."

   That is the whole argument and it is correct. A PO is the commercial unit
   — it is what is booked, what is planned against a line, what is shipped
   and what is invoiced. A style is a detail INSIDE it. Listing one row per
   style turns a four-style PO into four rows that look like four separate
   jobs, and a factory reading that list has to reassemble the PO in their
   head before they can do anything with it. Every one of those four rows
   carries the same date and the same CRD, so three of them are noise.

   So: one row per PO, expandable to the styles and colours underneath.

   --------------------------------------------------------------------------
   WRITTEN AGAINST WHAT THE ROWS ACTUALLY CONTAIN
   --------------------------------------------------------------------------
   `factory_portal_orders` is a database view whose definition is not in this
   repository, and the portal reads it with select("*"). Rather than assume a
   column list and produce blank cells or a crash the day the view changes,
   every optional field is looked up through `pick()`, which takes the first
   name that is actually present on the row. A field that genuinely is not
   served is then absent, not undefined-rendered-as-blank, and the table can
   drop the column instead of showing an empty one.

   --------------------------------------------------------------------------
   AGGREGATION: DISAGREEMENT IS SHOWN, NOT AVERAGED
   --------------------------------------------------------------------------
   Quantities add up. Dates do not. When every style in a PO carries the same
   ETD — the normal case — the PO row shows that date. When they DIFFER, the
   row says so and shows the range, because the alternative is picking one
   and being quietly wrong on a date a factory is planning a line against.
   The same rule applies to CRD and to status. Collapsing a difference is how
   a summary row becomes a lie.
*/

/* First present, non-empty value among several possible column names. */
function pick(row, names) {
  for (const n of names) {
    const v = row?.[n];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

/* The PO identity. Prefix + number is the real key — it is what
   assignFactory and PO cancellation already scope by — but the view may
   only expose a formatted `po` label, so that is the fallback. Never the
   row id: that is the STYLE's identity, which is the bug being fixed. */
export function poKeyOf(row) {
  const prefix = pick(row, ["po_prefix"]);
  const number = pick(row, ["po_number"]);
  if (prefix != null && number != null) return `${prefix}-${number}`;
  return String(pick(row, ["po", "po_label", "po_no"]) ?? "");
}

export function poLabelOf(row) {
  const label = pick(row, ["po", "po_label", "po_no"]);
  if (label) return String(label);
  const prefix = pick(row, ["po_prefix"]);
  const number = pick(row, ["po_number"]);
  return prefix != null && number != null ? `${prefix}${number}` : "—";
}

export const FIELD = {
  etd: ["etd"],
  qty: ["ordered_qty", "order_qty", "qty"],
  customer: ["customer_name", "customer"],
  productGroup: ["product_group_name", "product_group"],
  crd: ["current_crd", "crd"],
  status: ["shipment_status_label", "status_label"],
  style: ["style", "style_no", "style_name"],
  colour: ["color", "colour", "color_name", "colour_name"],
  merchandiser: ["merchandiser_name", "primary_merchandiser_name", "merchandiser"],
};

export const get = (row, field) => pick(row, FIELD[field] || [field]);

/* One distinct value, or a description of the disagreement.
   Returns { value, mixed, values } — `mixed` is what the row renders
   differently, and it is deliberately impossible to read the result as a
   single value without noticing. */
function agree(rows, field, { sort = false } = {}) {
  const seen = [];
  for (const r of rows) {
    const v = get(r, field);
    if (v === null) continue;
    if (!seen.includes(v)) seen.push(v);
  }
  if (sort) seen.sort();
  if (seen.length === 0) return { value: null, mixed: false, values: [] };
  if (seen.length === 1) return { value: seen[0], mixed: false, values: seen };
  return { value: seen[0], mixed: true, values: seen };
}

function sum(rows, field) {
  let total = 0, any = false;
  for (const r of rows) {
    const n = Number(get(r, field));
    if (Number.isFinite(n)) { total += n; any = true; }
  }
  return any ? total : null;
}

/* A date pair for a PO whose styles disagree. Earliest first — a factory
   planning a line needs to know the first date it is committed to, and the
   last one tells them how far the PO stretches. */
function dateRange(values) {
  if (values.length < 2) return null;
  const sorted = [...values].sort();
  return { from: sorted[0], to: sorted[sorted.length - 1] };
}

export function groupByPo(rows) {
  const byKey = new Map();
  for (const r of rows || []) {
    const key = poKeyOf(r);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }

  const groups = [];
  for (const [key, lines] of byKey) {
    const etd = agree(lines, "etd", { sort: true });
    const crd = agree(lines, "crd", { sort: true });
    const status = agree(lines, "status");
    const customer = agree(lines, "customer");
    const productGroup = agree(lines, "productGroup");
    const merchandiser = agree(lines, "merchandiser");

    /* Styles, deduplicated and in a stable order. A PO with four rows that
       are four COLOURS of one style is one style, and saying "4 styles"
       there would be wrong in the direction that matters — it would make a
       simple PO look complicated. */
    const styles = [];
    for (const l of lines) {
      const s = get(l, "style");
      if (s && !styles.includes(s)) styles.push(s);
    }

    groups.push({
      key,
      po: poLabelOf(lines[0]),
      lines,
      ids: lines.map(l => l.id),
      styles,
      styleCount: styles.length,
      lineCount: lines.length,
      qty: sum(lines, "qty"),
      etd: etd.value, etdMixed: etd.mixed, etdRange: dateRange(etd.values),
      crd: crd.value, crdMixed: crd.mixed,
      status: status.value, statusMixed: status.mixed, statuses: status.values,
      customer: customer.value, customerMixed: customer.mixed,
      productGroup: productGroup.value, productGroupMixed: productGroup.mixed,
      merchandiser: merchandiser.value, merchandiserMixed: merchandiser.mixed,
    });
  }

  /* Earliest delivery first — the factory's own working order. A PO with no
     date at all sorts last rather than first, so a missing date can never
     push itself to the top of somebody's work list. */
  groups.sort((a, b) => {
    if (!a.etd && !b.etd) return a.po.localeCompare(b.po);
    if (!a.etd) return 1;
    if (!b.etd) return -1;
    return a.etd < b.etd ? -1 : a.etd > b.etd ? 1 : a.po.localeCompare(b.po);
  });
  return groups;
}

/* Which columns are worth showing, decided from the data rather than
   assumed. A view that does not serve a merchandiser name should not
   produce a Merchandiser column full of dashes. */
export function availableColumns(rows) {
  const has = field => (rows || []).some(r => get(r, field) !== null);
  return {
    style: has("style"),
    colour: has("colour"),
    merchandiser: has("merchandiser"),
    productGroup: has("productGroup"),
    customer: has("customer"),
    crd: has("crd"),
  };
}

export const __internals = { pick, agree, sum, dateRange };
