/* ==========================================================================
   What a garment costs, in one place.
   ==========================================================================
   The report:

     "FOB is for each style different, even can be different based on fabric
      colour different (but very rare case, once any fabric colour dyes are
      expensive then that style-colour FOB becomes different) … Need to put
      FOB per style (if possible per colour but making design simplify)."

   And his own Orders Tracking sheet says exactly the same thing in rows:

     RT30729  OGASE020  001 CAVIAR        600   $3.51+$0.08  $3.59
     RT30729  OGASE020  039 QUIET SHADE   492   $3.51+$0.08  $3.59
     RT30729  OGASG059  118 BRIGHT WHITE  360   $3.87+$0.08  $3.95
     RT30729  OGASG059  417 BLACK IRIS    360   $3.87+$0.08  $3.95

   One PO, two styles, two prices. Every colour of a style shares that
   style's price — until, rarely, one does not.

   --------------------------------------------------------------------------
   THE GRAIN WAS ALREADY RIGHT; THE SCREEN DID NOT SAY SO
   --------------------------------------------------------------------------
   `orders` holds one row per PO + STYLE, so `orders.fob` has always been the
   STYLE's price, not the PO's. Nothing made it PO-wide — the PO-wide fields
   are the merchandiser and the ETD buffer, and only those.

   What was missing was two things. The screen is titled "Edit Order — RT30729"
   and offers FOB with no indication of what it applies to, so there was no way
   to tell a per-style field from a PO-wide one by looking. And there was
   nowhere at all to record the rare colour that costs more.

   --------------------------------------------------------------------------
   THE SIMPLIFICATION HE ASKED FOR: AN OVERRIDE, NOT A SECOND PRICE LIST
   --------------------------------------------------------------------------
   `order_color_ways.fob` is NULL for almost every colour, and NULL means
   "this colour costs what the style costs". Only the exceptional colour
   carries a number.

   The alternative — copying the style price onto every colour row — was
   rejected deliberately. It would mean a four-colour style has five places
   holding the same figure, four of which go stale the moment the style price
   is renegotiated, and the first time they disagree nobody can tell which one
   is right. An override cannot drift: there is exactly one price until
   somebody deliberately states otherwise.

   --------------------------------------------------------------------------
   WHAT IS DELIBERATELY NOT HERE
   --------------------------------------------------------------------------
   The sheet's "$3.51 + $0.08" breakdown, and its Fty FOB / Additional Price
   columns. The ERP stores the TOTAL, which is what every value figure
   multiplies by. Splitting it would add columns that no report reads and that
   would have to be kept adding up to the total by hand.
*/

/* One colour's price. The override if there is one, otherwise the style's.

   `0` is a real price and must survive: `colorWay.fob || order.fob` would
   throw away a genuinely free sample line and quietly substitute the style
   price, which is the sort of bug that shows up as a number nobody can
   account for. Hence the explicit null/undefined test. */
export function colourFob(colorWay, order) {
  const own = colorWay?.fob;
  if (own !== null && own !== undefined && own !== "") {
    const n = Number(own);
    if (Number.isFinite(n)) return n;
  }
  const styleFob = order?.fob;
  if (styleFob === null || styleFob === undefined || styleFob === "") return null;
  const n = Number(styleFob);
  return Number.isFinite(n) ? n : null;
}

export function hasColourOverride(colorWay) {
  const v = colorWay?.fob;
  return v !== null && v !== undefined && v !== "";
}

export function anyColourOverride(colorWays) {
  return (colorWays || []).some(hasColourOverride);
}

/* What this order line is worth.

   Two routes, and which one is taken is decided by the data rather than by a
   setting:

     - No colour carries an override -> qty x the style price. This is the
       normal case and it uses the ORDER's own quantity, which is the
       authoritative one.

     - Some colour does -> sum over the colours. This is the only way to get
       the right answer when two colours of one style cost different amounts.

   The second route depends on the colour quantities adding up to the order
   quantity. They normally do, but a colour breakdown can be incomplete —
   half-entered, or an order split after the fact. When they disagree, the
   shortfall is priced at the STYLE rate rather than being dropped, because a
   silently smaller total is worse than a slightly approximate one: a missing
   colour row would make an order look cheaper than it is and nothing on the
   screen would say why. `reconciled` reports whether that happened, so a
   screen can show it rather than the reader having to notice.
*/
export function orderValue(order, colorWays) {
  if (!order || !("fob" in order)) return { value: null, basis: "no-permission", reconciled: true };
  const qty = Number(order.qty) || 0;
  const styleFob = order.fob === null || order.fob === undefined ? null : Number(order.fob);

  if (!anyColourOverride(colorWays)) {
    if (styleFob === null || !Number.isFinite(styleFob)) {
      return { value: null, basis: "no-price", reconciled: true };
    }
    return { value: qty * styleFob, basis: "style", reconciled: true };
  }

  let sum = 0, counted = 0, priced = true;
  for (const cw of colorWays) {
    const cwQty = Number(cw.qty) || 0;
    const price = colourFob(cw, order);
    if (price === null) { priced = false; continue; }
    sum += cwQty * price;
    counted += cwQty;
  }
  const shortfall = qty - counted;
  if (shortfall > 0 && styleFob !== null && Number.isFinite(styleFob)) {
    sum += shortfall * styleFob;
  }
  return {
    value: priced ? sum : null,
    basis: "colour",
    reconciled: shortfall === 0,
    colourQty: counted,
    orderQty: qty,
  };
}

/* The same figure for a quantity that is not the ordered one — a shipped
   quantity, most often. Proportional to the order's own average price, which
   is the only defensible answer without knowing WHICH colours shipped.

   Where the colours that shipped ARE known, the shipment lines carry their
   own unit_price and that is used instead; this is the fallback for the
   order-level shape, and it is honest about being an average rather than
   pretending to a precision it does not have. */
export function valueForQty(order, colorWays, qty) {
  const { value, basis } = orderValue(order, colorWays);
  const orderedQty = Number(order?.qty) || 0;
  if (value === null) return null;
  if (!orderedQty) return 0;
  return (value / orderedQty) * (Number(qty) || 0);
}

/* The average price per piece across the whole order line — what to show in a
   single FOB column when the colours underneath disagree. Returned alongside
   `mixed` so the column can say so rather than presenting an average as if it
   were a quoted price. */
export function effectiveFob(order, colorWays) {
  const prices = new Set();
  for (const cw of colorWays || []) {
    const p = colourFob(cw, order);
    if (p !== null) prices.add(p);
  }
  if (prices.size === 0) {
    const f = order?.fob;
    const n = f === null || f === undefined ? null : Number(f);
    return { fob: Number.isFinite(n) ? n : null, mixed: false };
  }
  if (prices.size === 1) return { fob: [...prices][0], mixed: false };
  const { value } = orderValue(order, colorWays);
  const qty = Number(order?.qty) || 0;
  return { fob: value !== null && qty ? value / qty : null, mixed: true, prices: [...prices].sort((a, b) => a - b) };
}

/* Roll a PO's style lines up the way the sheet does: a PO total, and the
   styles under it each with their own price. Used by the Pricing panel and
   by anything that wants to show "this PO is worth X across Y styles". */
export function poPricing(orders, colorWaysByOrder) {
  const lines = (orders || []).map(o => {
    const cws = colorWaysByOrder?.get?.(o.id) || colorWaysByOrder?.[o.id] || [];
    const v = orderValue(o, cws);
    const eff = effectiveFob(o, cws);
    return { order: o, colorWays: cws, ...v, fob: eff.fob, fobMixed: eff.mixed };
  });
  const qty = lines.reduce((s, l) => s + (Number(l.order.qty) || 0), 0);
  const anyUnpriced = lines.some(l => l.value === null);
  const value = anyUnpriced ? null : lines.reduce((s, l) => s + l.value, 0);
  const distinctFob = new Set(lines.map(l => l.fob).filter(f => f !== null));
  return {
    lines, qty, value,
    styleCount: new Set(lines.map(l => l.order.style).filter(Boolean)).size,
    fobMixed: distinctFob.size > 1 || lines.some(l => l.fobMixed),
    anyUnpriced,
  };
}
