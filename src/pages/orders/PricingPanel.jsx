import React, { useCallback, useEffect, useMemo, useState } from "react";
import { getPoPricing, setStyleFob, setColourFob, setColourQty, setStyleQty, colourFobAvailable } from "../../lib/ordersApi.js";
import { poPricing, colourFob, hasColourOverride } from "../../lib/pricing.js";

/* ==========================================================================
   Pricing — the PO, its styles, and the colours underneath.
   ==========================================================================
   Built to read like the Orders Tracking sheet, because that is the shape the
   office already thinks in:

     PO        STYLE      COLOUR            QTY   FOB     VALUE
     RT30729   OGASE020   001 CAVIAR        600   $3.59   $2,154.00
                          039 QUIET SHADE   492   $3.59   $1,766.28
               OGASG059   118 BRIGHT WHITE  360   $3.95   $1,422.00
                          417 BLACK IRIS    360   $3.95   $1,422.00

   The whole PO on one screen is the point. Order Detail shows one style at a
   time, which is correct for everything else it does and is exactly why two
   styles of one PO can sit at the same wrong price for months without anyone
   noticing. Side by side, it takes a glance.

   --------------------------------------------------------------------------
   TWO PRICES, AND THE SECOND ONE IS USUALLY BLANK
   --------------------------------------------------------------------------
   The STYLE price is the real one and is where a price is normally set. The
   COLOUR field beside each colour is an OVERRIDE, and leaving it blank — the
   normal state — means that colour costs whatever its style costs. It exists
   for the case he described: one colour whose dye is expensive.

   A blank colour field therefore shows the inherited price in grey, so it is
   obvious the colour HAS a price rather than looking unpriced. Clearing an
   override returns the colour to the style price rather than to nothing.

   --------------------------------------------------------------------------
   QUANTITY IS EDITED HERE TOO, AND THE STYLE TOTAL IS NOT TYPED
   --------------------------------------------------------------------------
   "qty and price are now colour level, and should have update facility."

   Quantity is edited on the COLOUR, and the style total is the sum of its
   colours — shown, not offered as a box. That is not a restriction, it is the
   only arrangement in which the two can never disagree: `orders.qty` is what
   every report, KPI and value figure reads, and a style total somebody could
   type to contradict its own colours would make all of them quietly wrong
   with nothing on screen to say so.

   A style with NO colour breakdown has nothing to derive a total from, so
   there the quantity IS typed directly. The box appears only in that case.
*/

function money(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function price(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${Number(n).toFixed(2)}`;
}

/* One editable price cell. Kept local so a keystroke does not re-render the
   whole PO, and committed on blur or Enter rather than on every character —
   a save per keystroke would write "3", "3.9", "3.95" to the audit log. */
function NumInput({ value, placeholder, disabled, title, step = "0.01", width, onCommit }) {
  const [draft, setDraft] = useState(value ?? "");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(value ?? ""); }, [value]);

  async function commit() {
    const next = draft === "" ? null : draft;
    const same = (next === null && (value === null || value === undefined)) || String(next) === String(value ?? "");
    if (same) return;
    setBusy(true);
    try { await onCommit(next); }
    finally { setBusy(false); }
  }

  return (
    <input
      className="fob-input"
      style={width ? { width } : undefined}
      type="number" step={step} min="0" inputMode="decimal"
      value={draft}
      placeholder={placeholder}
      disabled={disabled || busy}
      title={title}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); if (e.key === "Escape") setDraft(value ?? ""); }}
    />
  );
}

export default function PricingPanel({ order, canEdit, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await getPoPricing(order.po_prefix, order.po_number)); }
    catch (e) { setError(e.message); }
    setLoading(false);
  }, [order.po_prefix, order.po_number]);

  useEffect(() => { load(); }, [load]);

  const roll = useMemo(
    () => (data ? poPricing(data.orders, data.colorWaysByOrder) : null),
    [data]);

  async function save(fn, what) {
    setError(null); setNotice(null);
    try {
      await fn();
      await load();
      setNotice(`${what} saved.`);
      onChanged?.();
    } catch (e) { setError(e.message); }
  }

  if (loading) return <div className="pp-wrap"><p className="muted-sm">Loading prices…</p></div>;
  if (error && !data) return <div className="pp-wrap"><p style={{ color: "#B91C1C" }}>{error}</p></div>;
  if (!data?.canFob) {
    return (
      <div className="pp-wrap">
        <p className="muted-sm">You do not have permission to see FOB prices.</p>
      </div>
    );
  }

  const colourEditable = canEdit && colourFobAvailable();

  return (
    <div className="pp-wrap">
      <div className="pp-head">
        <div>
          <h3 className="pp-title">Qty &amp; Pricing — {order.po_prefix}{order.po_number}</h3>
          <p className="pp-sub">
            Quantity is entered on the <strong>colour</strong>; the style total is the
            sum of its colours. FOB belongs to the <strong>style</strong> — leave a colour
            blank unless that one colour genuinely costs something different.
          </p>
        </div>
        <div className="pp-total">
          <span className="pp-total-l">{roll.styleCount} style{roll.styleCount !== 1 ? "s" : ""} · {roll.qty.toLocaleString()} pcs</span>
          <span className="pp-total-n">{roll.anyUnpriced ? "—" : money(roll.value)}</span>
        </div>
      </div>

      {error && <p style={{ color: "#B91C1C", fontSize: 12.5 }}>{error}</p>}
      {notice && <p style={{ color: "#15803D", fontSize: 12.5 }}>{notice}</p>}
      {!colourFobAvailable() && (
        <p className="pp-warn">
          Colour-level prices are not available on this database yet — migration 41 has
          not been run. Style prices work normally; the colour column is read-only.
        </p>
      )}

      <table className="data-table pp-table">
        <thead>
          <tr>
            <th>Style</th>
            <th>Colour</th>
            <th className="num">Qty</th>
            <th className="num">FOB</th>
            <th className="num">Value</th>
          </tr>
        </thead>
        <tbody>
          {roll.lines.map(line => {
            const o = line.order;
            const isThisStyle = o.id === order.id;
            const colours = line.colorWays;
            return (
              <React.Fragment key={o.id}>
                <tr className={"pp-style" + (isThisStyle ? " on" : "")}>
                  <td>
                    <strong>{o.style || "—"}</strong>
                    {isThisStyle && <span className="pp-here" title="The style you are looking at">open</span>}
                  </td>
                  <td className="muted-sm">
                    {colours.length
                      ? `${colours.length} colour${colours.length !== 1 ? "s" : ""}`
                      : "no colour breakdown"}
                  </td>
                  <td className="num">
                    {colours.length ? (
                      /* Derived, not typed. The sum of the colours below it —
                         showing a box here would let somebody set a total its
                         own colours contradict, and `orders.qty` is what every
                         report reads. */
                      <span className="pp-derived" title={`Sum of ${colours.length} colour${colours.length !== 1 ? "s" : ""} — edit the colours below`}>
                        {(Number(o.qty) || 0).toLocaleString()}
                      </span>
                    ) : canEdit ? (
                      <NumInput
                        value={o.qty ?? ""}
                        step="1" width={72}
                        placeholder="—"
                        title="This style has no colour breakdown, so its quantity is entered directly."
                        onCommit={v => save(() => setStyleQty(o.id, v), `${o.style} quantity`)}
                      />
                    ) : (Number(o.qty) || 0).toLocaleString()}
                  </td>
                  <td className="num">
                    {canEdit ? (
                      <NumInput
                        value={o.fob ?? ""}
                        placeholder="—"
                        title="The price for this style. Every colour under it uses this unless it carries its own."
                        onCommit={v => save(() => setStyleFob(o.id, v), `${o.style} price`)}
                      />
                    ) : price(o.fob)}
                  </td>
                  <td className="num">{line.value === null ? "—" : money(line.value)}</td>
                </tr>

                {colours.map(cw => {
                  const own = hasColourOverride(cw);
                  const used = colourFob(cw, o);
                  const cwQty = Number(cw.qty) || 0;
                  return (
                    <tr key={`${o.id}:${cw.name}`} className="pp-colour">
                      <td />
                      <td>
                        {cw.name}
                        {own && <span className="pp-own" title="This colour carries its own price, different from its style">own price</span>}
                      </td>
                      <td className="num">
                        {canEdit ? (
                          <NumInput
                            value={cw.qty ?? ""}
                            step="1" width={72}
                            placeholder="0"
                            title="The quantity of this colour. The style total above is the sum of these."
                            onCommit={v => save(() => setColourQty(o.id, cw.name, v), `${cw.name} quantity`)}
                          />
                        ) : cwQty.toLocaleString()}
                      </td>
                      <td className="num">
                        {colourEditable ? (
                          <NumInput
                            value={cw.fob ?? ""}
                            placeholder={o.fob != null ? Number(o.fob).toFixed(2) : "—"}
                            title={own
                              ? "This colour's own price. Clear it to go back to the style price."
                              : "Blank — this colour costs what the style costs. Type a number only if it genuinely differs."}
                            onCommit={v => save(() => setColourFob(o.id, cw.name, v), `${cw.name} price`)}
                          />
                        ) : (
                          <span className={own ? "" : "pp-inherited"}>{price(used)}</span>
                        )}
                      </td>
                      <td className="num">{used === null ? "—" : money(cwQty * used)}</td>
                    </tr>
                  );
                })}

                {/* A colour breakdown that does not add up to the order quantity
                    is not an error — an order can be split, or half-entered —
                    but the difference has to be visible, because it is priced
                    at the style rate and would otherwise be invisible
                    arithmetic. */}
                {colours.length > 0 && line.reconciled === false && (
                  <tr className="pp-colour">
                    <td />
                    <td colSpan={4} className="pp-gap">
                      Colours account for {line.colourQty.toLocaleString()} of{" "}
                      {line.orderQty.toLocaleString()} pcs — the remaining{" "}
                      {(line.orderQty - line.colourQty).toLocaleString()} are priced at the style rate.
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={2}><strong>PO total</strong></td>
            <td className="num"><strong>{roll.qty.toLocaleString()}</strong></td>
            <td className="num">{roll.fobMixed ? <span className="pp-mixed" title="The styles under this PO are not all the same price">mixed</span> : price(roll.lines[0]?.fob)}</td>
            <td className="num"><strong>{roll.anyUnpriced ? "—" : money(roll.value)}</strong></td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
