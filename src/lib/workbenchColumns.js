/* Workbench frozen-column geometry.

   The history here is the reason this file exists. The frozen columns were
   sized as hardcoded pixel widths in CSS, with each column's `left` being
   the hand-maintained sum of the widths before it. That arrangement has now
   produced the same class of bug three times: a column too narrow for its
   own content (ETD clipped a full-year date, Qty clipped a thousands
   separator, FOB clipped its cents), fixed by nudging a number, which then
   required every following `left` to be nudged too.

   So the geometry moved here and became data:

   - Widths live in ONE array. Offsets are COMPUTED from it, never written
     down, so they cannot drift out of step with the widths again.
   - Every default width is derived from the widest string that column can
     actually hold, measured in the app's own font (see WIDTH NOTES below),
     rather than chosen by eye.
   - The user can drag any of them, and double-click to auto-fit to the
     widest value currently on screen. Their choice is remembered per
     browser. Different offices work with different PO and colour naming, so
     one "correct" width does not exist — the sensible design is a good
     default plus the ability to change it.
*/

/* WIDTH NOTES — measured at 11.5px 'IBM Plex Mono' (≈6.93px per character)
   plus 12px of cell padding, then rounded up for comfort:
     PO      "TEST0003"      8 ch → 55 + 12 = 67  → 88
     Style   "SWBSD021"      8 ch → 55 + 12 = 67  → 96
     Colour  "403 TOTAL ECLIPSE" 17 ch → 118 + 12 = 130 → 140
     Qty     "1,234,567"     9 ch → 62 + 12 = 74  → 84
     FOB     "$1,234.56"     9 ch → 62 + 12 = 74  → 82
     ETD     "01-Mar-2026"  11 ch → 76 + 12 = 88  → 96   (was 104: fractionally
                                                          wider than needed)
     Rev ETD same as ETD                                → 96
*/
/* Factory and Label were added in v90 at the owner's request: finding the one
   order to update means recognising it, and "which factory / which label" is
   how a merchandiser recognises it. They are deliberately narrower than their
   longest value and clip with an ellipsis — a factory name like "OCEAN SWEATER
   IND. (PVT) LTD" would otherwise eat 190px of the frozen block on every row,
   and the frozen block is space taken away from the milestones. The full name
   is on the cell's tooltip, and either column can be dragged wider or hidden
   like any other. */
export const FROZEN_COLUMNS = [
  { key: "select",  label: "",        width: 34,  min: 32,  max: 44,  resizable: false },   // a checkbox carries ~6px of its own margin
  { key: "po",      label: "PO",      width: 88,  min: 62,  max: 220 },
  { key: "style",   label: "Style",   width: 96,  min: 62,  max: 240 },
  { key: "color",   label: "Color",   width: 140, min: 70,  max: 320 },
  { key: "factory", label: "Factory", width: 118, min: 60,  max: 300, clip: true, optional: true },
  { key: "label",   label: "Label",   width: 104, min: 60,  max: 260, clip: true, optional: true },
  { key: "qty",     label: "Qty",     width: 84,  min: 60,  max: 180, align: "right" },
  { key: "fob",     label: "FOB",     width: 82,  min: 60,  max: 180, align: "right" },
  { key: "etd",     label: "ETD",     width: 96,  min: 72,  max: 200, clip: true },
  { key: "revEtd",  label: "Rev ETD", width: 96,  min: 72,  max: 200, clip: true },
  { key: "actions", label: "",        width: 56,  min: 48,  max: 90,  resizable: false },
];

/* The milestone area to the right of the freeze line.

   These exist because the table is now `table-layout: fixed` with a real
   <colgroup>. That change matters more than it sounds: under the default
   auto layout a cell's `width` is only a SUGGESTION — the browser stretches
   or shrinks it to fit the table — so the frozen columns' pixel widths and
   the sticky `left` offsets computed from them were only ever *hoped* to
   agree. Under fixed layout with a colgroup they agree by construction,
   and the harness can prove it: every column's rendered left equals the
   exact running sum of the widths above.

   Widths are sized for what the cells actually contain, and measured in a
   real browser rather than guessed: a native date input with its calendar
   button needs ~126px at this font (122px clipped the year to "12/21/202"),
   and the status select is capped at 78px by .wb-status. */
/* From v87 a plan/date/status milestone occupies ONE column, not three.
   Plan and Actual are stacked inside the cell with the Status control under
   them, which is both easier to read (the plan-to-actual relationship is
   vertical and adjacent, not spread across three headers) and dramatically
   narrower: nineteen milestones went from roughly 6,950px of horizontal
   scroll to about 2,850px, so six or seven milestones are on screen at once
   instead of two.

   The width is measured, not guessed: a native date input with its calendar
   button needs ~126px at this font, and 150px carries it with the "P"/"A"
   gutter and cell padding. */
/* A free-text column holds things like "TERESA(TM505-AH116)DADA-FUHUA FABRIC"
   — 36 characters, where a date is 8. Sizing it the same as a single-date
   column clipped every fabric reference in the grid, so text gets its own
   width and the cell carries the full value on hover. */
export const MILESTONE_WIDTHS = { stack: 150, single: 156, text: 232 };

export function milestoneWidthsFor(cols) {
  const out = [];
  for (const c of cols || []) out.push(
    c.field_type === "pds" ? MILESTONE_WIDTHS.stack
    : c.field_type === "text" ? MILESTONE_WIDTHS.text
    : MILESTONE_WIDTHS.single);
  return out;
}

export function defaultWidths() {
  return FROZEN_COLUMNS.map(c => c.width);
}

/* Offsets are always derived, never stored — this is the invariant that
   was previously maintained by hand and broke every time. */
export function offsetsFor(widths) {
  const lefts = [];
  let acc = 0;
  for (const w of widths) { lefts.push(acc); acc += w; }
  return { lefts, total: acc };
}

export function clampWidth(index, width) {
  const col = FROZEN_COLUMNS[index];
  if (!col) return width;
  return Math.max(col.min, Math.min(col.max, Math.round(width)));
}

const STORAGE_KEY = "erp.workbench.frozenWidths.v1";

/* A saved width array from before Factory and Label existed has nine entries
   where there are now eleven. Restoring it positionally would shift every
   column's width onto the wrong column — the geometry equivalent of an
   off-by-two. Anything of the wrong length is simply discarded in favour of
   the defaults, which is a one-time loss of a personal preference rather than
   a grid that silently renders wrong. */
export function loadWidths() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultWidths();
    const saved = JSON.parse(raw);
    if (!Array.isArray(saved) || saved.length !== FROZEN_COLUMNS.length) return defaultWidths();
    // Clamped on read as well as on write: a stored value from an older
    // column set must never be able to produce an unusable layout.
    return saved.map((w, i) => clampWidth(i, Number(w) || FROZEN_COLUMNS[i].width));
  } catch { return defaultWidths(); }
}

export function saveWidths(widths) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(widths)); } catch { /* private mode — the layout still works, it just isn't remembered */ }
}

export function clearWidths() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* nothing to clean up */ }
}

/* Auto-fit: measure the real strings this column currently holds in the
   real font, and size to the widest — the header included, since a column
   narrower than its own heading looks broken. */
let canvasCtx = null;
function measure(text, font) {
  if (!canvasCtx) {
    const c = typeof document !== "undefined" ? document.createElement("canvas") : null;
    canvasCtx = c ? c.getContext("2d") : null;
  }
  if (!canvasCtx) return String(text).length * 7;   // headless fallback
  canvasCtx.font = font;
  return canvasCtx.measureText(String(text ?? "")).width;
}

export const CELL_FONT = "11.5px 'IBM Plex Mono', ui-monospace, monospace";
export const HEAD_FONT = "600 11px -apple-system, 'Segoe UI', Roboto, sans-serif";

export function autoFitWidth(index, values) {
  const col = FROZEN_COLUMNS[index];
  if (!col) return null;
  let widest = measure(col.label, HEAD_FONT);
  for (const v of values) {
    const w = measure(v, CELL_FONT);
    if (w > widest) widest = w;
  }
  return clampWidth(index, widest + 16);   // 12px padding + 4px breathing room
}
