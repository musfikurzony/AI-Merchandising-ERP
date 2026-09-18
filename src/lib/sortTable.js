import { useCallback, useMemo } from "react";
import { useSticky } from "./viewState.js";

/* ==========================================================================
   Click a column heading, sort by it.
   ==========================================================================
   The report:

     "Same PO RT5077, some style/colour found at top of chart but some at the
      bottom, which is difficult to review at a glance… can you make it by
      user sorting on each column header?"

   Worth saying what actually split that PO, because it is not randomness:
   the list is ordered by delivery date, four of RT5077's rows carry
   04/10/26 and two carry none at all, and a row with no date sorts to the
   end. The PO was in two places because its own rows disagree about a date —
   which v99's PO-wide ETD fixes the moment any style of it is saved.

   User sorting is the right answer anyway. A merchandiser reviewing a
   factory's book wants it by PO; one chasing deliveries wants it by date;
   one checking prices wants it by style. No single default serves all three.

   --------------------------------------------------------------------------
   THREE RULES THAT MATTER MORE THAN THE SORTING ITSELF
   --------------------------------------------------------------------------
   1. BLANKS ALWAYS LAST, in both directions. The obvious implementation puts
      them first when descending, which means clicking "ETD" twice fills the
      top of the screen with the rows that have no ETD — the least useful
      rows, in the most prominent place, exactly when somebody is trying to
      see the latest deliveries.

   2. TIES CHAIN TO PO, STYLE, COLOUR. Two rows with the same delivery date
      used to fall back on whatever order the database happened to return,
      so a PO's styles could interleave with another PO's. Chaining means a
      PO's rows stay adjacent whatever column is being sorted, which is most
      of what he was actually asking for.

   3. THE SORT IS PART OF THE VIEW. It survives leaving the tab (v93's
      sessionStorage rule) and it travels into the Excel export, because an
      export that ignores the order on screen is the same class of bug as
      one that ignored the filters — fixed once already, in v88.
*/

/* Compare two values of a known kind. Both null-safe, and neither ever puts
   a blank above a real value. */
function cmpText(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}
function cmpNumber(a, b) {
  const x = Number(a), y = Number(b);
  if (!Number.isFinite(x) && !Number.isFinite(y)) return 0;
  if (!Number.isFinite(x)) return 1;
  if (!Number.isFinite(y)) return -1;
  return x - y;
}
/* Dates arrive as ISO strings (YYYY-MM-DD), which sort correctly as text.
   Deliberately NOT parsed into Date objects: that costs an allocation per
   comparison on a list that can run to thousands of rows, and buys nothing. */
function cmpDate(a, b) {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

const COMPARATORS = { text: cmpText, number: cmpNumber, date: cmpDate };

export function isBlank(v) {
  return v === null || v === undefined || v === "" || v === "—";
}

/* One column's comparator, with the blanks-last rule applied OUTSIDE the
   direction flip — which is the whole point. `dir` inverts the comparison of
   two real values; it never promotes a blank. */
export function compareBy(column, dir) {
  const base = COMPARATORS[column?.kind || "text"] || cmpText;
  const get = column?.value || (row => row?.[column?.key]);
  const sign = dir === "desc" ? -1 : 1;
  return (rowA, rowB) => {
    const a = get(rowA), b = get(rowB);
    const blankA = isBlank(a), blankB = isBlank(b);
    if (blankA && blankB) return 0;
    if (blankA) return 1;
    if (blankB) return -1;
    return sign * base(a, b);
  };
}

/* Sort a flat list of rows.

   `columns` is the full column list; `sort` is { key, dir }. `tieBreak` is a
   list of column keys applied in order when the chosen column ties — that is
   what keeps a PO's rows together no matter what is being sorted by.

   Returns a NEW array; the input is never mutated, because the caller's
   unsorted list is usually memoised upstream and mutating it would make the
   next render sort an already-sorted array by a different key. */
export function sortRows(rows, columns, sort, tieBreak = []) {
  if (!Array.isArray(rows) || rows.length < 2) return rows || [];
  const byKey = new Map(columns.map(c => [c.key, c]));
  const primary = sort?.key ? byKey.get(sort.key) : null;

  const chain = [];
  if (primary) chain.push(compareBy(primary, sort.dir));
  for (const key of tieBreak) {
    if (primary && key === sort.key) continue;      // already the primary
    const col = byKey.get(key);
    if (col) chain.push(compareBy(col, "asc"));
  }
  if (!chain.length) return rows;

  return [...rows].sort((a, b) => {
    for (const cmp of chain) {
      const r = cmp(a, b);
      if (r !== 0) return r;
    }
    return 0;
  });
}

/* The hook a screen uses.

     const [sort, toggleSort] = useTableSort("orders", { key: "etd", dir: "asc" });

   Clicking the active column flips direction; clicking a different one
   starts that column ascending. There is deliberately no third "unsorted"
   state: a table always has SOME order, and cycling back to "whatever the
   database returned" is not a state anybody wants to land on by accident. */
export function useTableSort(scope, initial) {
  const [sort, setSort] = useSticky(scope, "sort", initial);
  const toggleSort = useCallback(key => {
    setSort(prev => (prev?.key === key
      ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { key, dir: "asc" }));
  }, [setSort]);
  return [sort, toggleSort, setSort];
}

/* Convenience for a screen that has its columns and rows and just wants the
   sorted result, memoised on the things that actually change. */
export function useSortedRows(rows, columns, sort, tieBreak) {
  return useMemo(
    () => sortRows(rows, columns, sort, tieBreak),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, columns, sort?.key, sort?.dir, tieBreak?.join?.(",")]);
}

export const __internals = { cmpText, cmpNumber, cmpDate };
