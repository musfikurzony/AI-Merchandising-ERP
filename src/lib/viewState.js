import { useCallback, useEffect, useRef, useState } from "react";

/* ==========================================================================
   Keeping a screen where the user left it.
   ==========================================================================
   The complaint: set up filters on the Workbench, switch to another browser
   tab for ten minutes, come back — everything is back to defaults and the
   filtering has to be done again.

   Worth being precise about the cause, because it changes the fix. Switching
   browser tabs does NOT reset React state; the page is not reloaded and no
   code runs. Nothing in this application listens for focus or visibility
   either (checked). So the state is being lost one of two ways:

     1. the screen was navigated away from and back inside the app, which
        unmounts the component and takes its useState with it; or
     2. the browser DISCARDED the tab — Chrome's Memory Saver reclaims
        background tabs and silently reloads them when you return.

   Both look identical to the user, and both are fixed the same way: put the
   view state somewhere that outlives the component.

   --------------------------------------------------------------------------
   WHY sessionStorage AND NOT localStorage
   --------------------------------------------------------------------------
   sessionStorage is per-tab and dies when the tab closes. It survives a
   reload and survives Chrome discarding and restoring a tab, which is
   exactly the case being fixed.

   localStorage would also survive closing the browser — and that is the
   trap. A merchandiser filters to one factory on Friday afternoon, opens the
   ERP on Monday morning, sees a fraction of the order book and concludes
   data has gone missing. A filter nobody remembers setting is worse than a
   filter that was forgotten. Per-tab also means two tabs can hold two
   different filters, which is how people actually compare things.

   The one exception is `useStickyPreference`, at the bottom: a real
   preference (the date format) belongs in localStorage, because it is a
   statement about the person rather than about what they were just looking
   at.

   --------------------------------------------------------------------------
   WHAT IS AND IS NOT KEPT
   --------------------------------------------------------------------------
   Kept: filters, search text, the selected tab, grouping, sort, page size,
   chosen dimension, period — the choices that took effort to make.

   Never kept: fetched data (it would go stale and mislead), loading and
   error flags (a restored error message would be a lie), open modals
   (reopening a dialog nobody asked for), unsaved edit drafts (the Workbench's
   pending cell edits are deliberately NOT restored — silently resurrecting
   half-typed dates that were never saved is how wrong dates get committed),
   and row selections for bulk actions.
*/

const PREFIX = "erp.view.";
const VERSION = 3;

/* Twelve hours. Long enough that stepping away for a meeting, or for lunch,
   or overnight-with-the-tab-open keeps your place; short enough that a tab
   restored days later starts clean. It also quietly defuses the
   time-dependent defaults: `defaultPeriod()` and `currentFiscalYear()` pin
   "this fiscal year" at the moment they run, and a stored period restored
   months later would silently show the wrong year with no clue on screen. */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

/* ---------------------------------------------------------------------------
   Storage, defensively.
   --------------------------------------------------------------------------- */
/* Every access is wrapped. sessionStorage is not merely absent in some
   contexts — it THROWS on access under blocked site data and in some
   embedded browsers. An exception here would take the whole screen down, and
   a screen that will not render is a far worse outcome than a filter that
   was not remembered. */
function store() {
  try {
    const s = window.sessionStorage;
    const probe = "__erp_probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch { return null; }
}

/* Sets and Maps do not survive JSON. Only one persisted value is a Set today
   (Backup & Export's selected datasets) but a hook that silently turned a Set
   into `{}` on restore would be a trap for whoever adds the next one. */
function replacer(_k, v) {
  if (v instanceof Set) return { __t: "Set", v: [...v] };
  if (v instanceof Map) return { __t: "Map", v: [...v] };
  return v;
}
function reviver(_k, v) {
  if (v && typeof v === "object" && v.__t === "Set") return new Set(v.v);
  if (v && typeof v === "object" && v.__t === "Map") return new Map(v.v);
  return v;
}

function readRaw(key) {
  const s = store();
  if (!s) return undefined;
  try {
    const raw = s.getItem(key);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw, reviver);
    if (!parsed || parsed.ver !== VERSION) { s.removeItem(key); return undefined; }
    if (Date.now() - parsed.at > MAX_AGE_MS) { s.removeItem(key); return undefined; }
    return parsed.value;
  } catch { return undefined; }
}

function writeRaw(key, value) {
  const s = store();
  if (!s) return;
  try { s.setItem(key, JSON.stringify({ ver: VERSION, at: Date.now(), value }, replacer)); }
  catch { /* quota, private mode — the screen still works, it just forgets */ }
}

/* ---------------------------------------------------------------------------
   Merging a stored value into today's default.
   ---------------------------------------------------------------------------
   Storage outlives deployments. A filter object saved by last week's build
   can be missing a field this build added, or carry one it removed, and
   restoring it verbatim would put `undefined` into a <select> — which React
   turns into an uncontrolled-component warning and a control that will not
   change.

   Named for what it does, and deliberately NOT `reconcile` — that word
   already means something else in this codebase (supabaseFetch.js reconciles
   a fetched row count against an exact COUNT), and two different
   reconciliations would be one grep away from confusing each other.

   So the DEFAULT defines the shape and the stored value only supplies
   values: a key the default does not have is dropped, a key it has but the
   stored object lacks keeps its default, and a value whose type no longer
   matches is ignored. Shape drift becomes a non-event rather than a bug
   report. */
function mergeWithDefaults(stored, fallback) {
  if (stored === undefined || stored === null) return fallback;

  const isPlain = v => v && typeof v === "object" && !Array.isArray(v)
    && !(v instanceof Set) && !(v instanceof Map);

  if (isPlain(fallback) && isPlain(stored)) {
    const out = {};
    for (const k of Object.keys(fallback)) {
      out[k] = k in stored ? mergeWithDefaults(stored[k], fallback[k]) : fallback[k];
    }
    return out;
  }
  if (fallback === null || fallback === undefined) return stored;
  if (Array.isArray(fallback) !== Array.isArray(stored)) return fallback;
  if (fallback instanceof Set && !(stored instanceof Set)) return fallback;
  if (typeof stored !== typeof fallback) return fallback;
  return stored;
}

/* ---------------------------------------------------------------------------
   Scope bookkeeping — so a screen can say "restored" and offer a reset.
   --------------------------------------------------------------------------- */
/* A scope is "restored" only when something came back AND it differs from the
   defaults. Restoring a screen that was already at its defaults is invisible,
   and announcing it would be noise on every single navigation. */
const restoredScopes = new Set();
const touchedScopes = new Set();      // the user has since changed something here
const resetters = new Map();          // scope -> Set of functions
const watchers = new Map();           // scope -> Set of functions, notified when it is touched

function notify(scope) {
  for (const fn of watchers.get(scope) || []) fn();
}

function registerReset(scope, fn) {
  if (!resetters.has(scope)) resetters.set(scope, new Set());
  resetters.get(scope).add(fn);
  return () => resetters.get(scope)?.delete(fn);
}

export function resetScope(scope) {
  const s = store();
  if (s) {
    for (const key of Object.keys(s).filter(k => k.startsWith(`${PREFIX}${scope}.`))) {
      try { s.removeItem(key); } catch { /* nothing to remove */ }
    }
  }
  restoredScopes.delete(scope);
  touchedScopes.delete(scope);
  for (const fn of resetters.get(scope) || []) fn();
}

/* Sign-out. Two people share a machine more often than anyone plans for, and
   the second one should not inherit the first one's view of the order book.
   Called from useSession.signOut(). */
export function clearAllViewState() {
  const s = store();
  if (s) {
    for (const key of Object.keys(s).filter(k => k.startsWith(PREFIX))) {
      try { s.removeItem(key); } catch { /* nothing to remove */ }
    }
  }
  restoredScopes.clear();
  touchedScopes.clear();
  for (const scope of watchers.keys()) notify(scope);
}

/* ---------------------------------------------------------------------------
   The hook.
   ---------------------------------------------------------------------------
   A drop-in replacement for useState, deliberately so: applying this to a
   screen is a one-line change per field rather than a rewrite of how that
   screen holds state. Nothing else about the component moves, which is what
   keeps the change reviewable across fourteen screens.

     const [filters, setFilters] = useState(EMPTY_FILTERS);
     const [filters, setFilters] = useSticky("orders", "filters", EMPTY_FILTERS);

   `fromUrl` is the one subtlety. Several screens are opened by drill-down
   links that carry their filters in the query string — the Dashboard's KPI
   tiles link to /orders?factory=F1. A stored filter must NEVER win over an
   explicit link, or clicking a tile would land on last hour's filters and the
   link would appear broken. Pass fromUrl: true and the given initial value
   wins and replaces what was stored.
*/
export function useSticky(scope, name, initial, { fromUrl = false, enabled = true } = {}) {
  const key = `${PREFIX}${scope}.${name}`;
  const resolve = () => (typeof initial === "function" ? initial() : initial);

  const [value, setValue] = useState(() => {
    if (!enabled || fromUrl) return resolve();
    const stored = readRaw(key);
    if (stored === undefined) return resolve();
    const fallback = resolve();
    const merged = mergeWithDefaults(stored, fallback);
    /* Compared against the DEFAULT, not merely "was something stored" — a
       stored value identical to the default is not worth telling anyone
       about. */
    try { if (JSON.stringify(merged, replacer) !== JSON.stringify(fallback, replacer)) restoredScopes.add(scope); }
    catch { restoredScopes.add(scope); }
    return merged;
  });

  /* The write is an effect rather than part of the setter so that functional
     updates (setPage(p => p + 1)) are stored too — a setter wrapper only sees
     the function, not the value it produces. */
  useEffect(() => {
    if (!enabled) return;
    writeRaw(key, value);
  }, [key, value, enabled]);

  /* A URL-seeded screen must also overwrite what was stored, not just ignore
     it. Otherwise the next plain visit restores the pre-link filters, which
     is the same bug one step removed. */
  const seeded = useRef(false);
  useEffect(() => {
    if (fromUrl && !seeded.current) { seeded.current = true; writeRaw(key, resolve()); }
  });

  useEffect(() => registerReset(scope, () => setValue(resolve())));

  /* Touching any control in this scope retires the "where you left off"
     notice: once the user has started changing things, the screen is theirs
     again and the notice would be describing history. */
  const set = useCallback(next => {
    if (!touchedScopes.has(scope)) { touchedScopes.add(scope); notify(scope); }
    setValue(next);
  }, [scope]);

  return [value, set];
}

/* What a screen needs to tell the user it restored something, and to undo it.

   `restored` is true only when something was actually read back AND it
   differs from the defaults — restoring a screen that was already at its
   defaults is invisible and announcing it would be noise. */
export function useStickyScope(scope) {
  const [, force] = useState(0);
  const restored = restoredScopes.has(scope) && !touchedScopes.has(scope);
  const reset = useCallback(() => {
    resetScope(scope);
    force(n => n + 1);
  }, [scope]);
  /* Subscribe rather than poll: the notice disappears on the very render
     after the user first touches a control in this scope. */
  useEffect(() => {
    if (!watchers.has(scope)) watchers.set(scope, new Set());
    const fn = () => force(n => n + 1);
    watchers.get(scope).add(fn);
    return () => watchers.get(scope)?.delete(fn);
  }, [scope]);
  return { restored, reset };
}

/* ---------------------------------------------------------------------------
   Preferences — the deliberate localStorage exception.
   ---------------------------------------------------------------------------
   The date format is not "what I was looking at", it is "how I read dates".
   It should survive closing the browser, and it carries none of the
   missing-data risk that a forgotten filter does: a date shown as 15/11/26
   instead of 11/15/26 is obvious on sight, and wrong-looking rather than
   absent. It has been resetting on every reload until now.
*/
export function useStickyPreference(name, initial) {
  const key = `erp.pref.${name}`;
  const [value, setValue] = useState(() => {
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? initial : mergeWithDefaults(JSON.parse(raw, reviver), initial);
    } catch { return initial; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(key, JSON.stringify(value, replacer)); }
    catch { /* private mode — it just is not remembered */ }
  }, [key, value]);
  return [value, setValue];
}

/* ---------------------------------------------------------------------------
   The paging trap.
   ---------------------------------------------------------------------------
   Screens that page their grid carry `useEffect(() => setPage(1), [filters])`
   so that changing a filter returns you to page 1. That effect also fires on
   MOUNT — so a restored page number is overwritten by 1 before it is ever
   rendered, and the restore appears not to work for that one field while
   working for every other.

   This runs the effect on every change EXCEPT the first, which is what the
   "reset to page 1 when the filter changes" rule actually meant all along.
*/
export function useEffectSkipFirst(fn, deps) {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    return fn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/* Exported for the tests, and for anyone debugging a stale restore. */
export const __internals = { PREFIX, VERSION, MAX_AGE_MS, mergeWithDefaults, readRaw, writeRaw };
