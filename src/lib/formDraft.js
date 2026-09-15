import { useCallback, useEffect, useRef, useState } from "react";

/* ==========================================================================
   Half-filled forms survive walking away from them.
   ==========================================================================
   The report: start adding a user, get as far as the email, switch away to
   look up the factory code, come back — the form is gone and every field has
   to be retyped. The Add User form makes this unavoidable rather than
   unlucky: the Factory Code field only appears once you have chosen a
   factory role, so the moment you need it is the moment you have to leave.

   --------------------------------------------------------------------------
   THIS DELIBERATELY REVERSES PART OF v93
   --------------------------------------------------------------------------
   `viewState.js` says, in prose, that unsaved edit drafts are never restored,
   because "silently resurrecting half-typed dates that were never saved is
   how wrong dates get committed". That reasoning is sound — for the Workbench
   GRID, where a restored cell is pixel-identical to a saved one and a
   merchandiser could press Save over values they never reviewed.

   It does not transfer to a FORM, and treating the two the same was the
   mistake. A form is visibly open, holds nothing until its Save button is
   pressed, announces that it was restored, and offers one click to discard.
   The danger in the grid came from restored data being indistinguishable
   from saved data; here it cannot be.

   So the rule is narrower than "never" and narrower than "always": a draft is
   restored when it is VISIBLY A DRAFT.

   --------------------------------------------------------------------------
   WHAT NEVER GOES IN HERE
   --------------------------------------------------------------------------
   Passwords. Not the login form, not the force-password-change form, not the
   temporary password shown after creating a user. `SECRET_FIELD` below drops
   anything whose name looks like a credential even if a caller forgets to
   exclude it — a blanket rule beats remembering, because the cost of getting
   it wrong once is a password sitting in localStorage on a shared office PC.

   Files, too. A File object cannot be serialised, and even if it could, the
   handle is meaningless after a reload — restoring "sheet 2 of the file you
   picked" while the file itself is gone is worse than restoring nothing.
*/

const PREFIX = "erp.draft.";
const VERSION = 1;

/* Seven days. A draft is an explicit, announced, discardable thing, so it can
   outlive the tab in a way a silent filter should not — that is the whole
   point of the report ("I went and did other work"). But not forever: a
   half-written user record from last month is noise, not help. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/* Anything matching this is stripped on the way in, whatever the caller
   asked for.

   Matched on WHOLE WORDS, not as a substring. A bare /pass/ also catches
   `compass` and `passport_no`, and over-matching is its own quiet bug: a
   legitimate field would simply never be saved and nobody would be told why.
   The name is split on camelCase and separators, and also tested with the
   separators removed so `apiKey` and `api_key` both reduce to `apikey`. */
const SECRET_WORDS = /^(password|passphrase|passwd|pwd|secret|token|credential|credentials|apikey|otp|pin)$/i;

export function isSecretField(name) {
  const raw = String(name || "");
  const words = raw.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (words.some(w => SECRET_WORDS.test(w))) return true;
  return SECRET_WORDS.test(raw.replace(/[^a-zA-Z0-9]+/g, ""));
}

/* Drafts are keyed per signed-in user. Two people share an office computer
   more often than anyone plans for, and the second one should not open Add
   User to the first one's half-typed colleague. Set from the session; until
   it is, drafts are anonymous and are cleared at sign-in. */
let owner = "anon";
export function setDraftOwner(userId) {
  const next = userId ? String(userId) : "anon";
  if (next !== owner) {
    /* A different person is now signed in — anything left anonymous or
       belonging to the previous owner is not theirs to inherit. */
    clearDraftsExcept(next);
    owner = next;
  }
}

function store() {
  try {
    const s = window.localStorage;
    s.setItem("__erp_draft_probe__", "1");
    s.removeItem("__erp_draft_probe__");
    return s;
  } catch { return null; }
}

function fullKey(key) { return `${PREFIX}${owner}.${key}`; }

/* Sets survive; Files and Blobs are dropped rather than silently becoming
   `{}`, which would restore a form field that looks filled and is not. */
function replacer(k, v) {
  if (isSecretField(k)) return undefined;
  if (typeof File !== "undefined" && v instanceof File) return undefined;
  if (typeof Blob !== "undefined" && v instanceof Blob) return undefined;
  if (v instanceof Set) return { __t: "Set", v: [...v] };
  return v;
}
function reviver(_k, v) {
  if (v && typeof v === "object" && v.__t === "Set") return new Set(v.v);
  return v;
}

export function readDraft(key) {
  const s = store();
  if (!s) return undefined;
  try {
    const raw = s.getItem(fullKey(key));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw, reviver);
    if (!parsed || parsed.ver !== VERSION || Date.now() - parsed.at > MAX_AGE_MS) {
      s.removeItem(fullKey(key));
      return undefined;
    }
    return parsed.value;
  } catch { return undefined; }
}

function writeDraft(key, value) {
  const s = store();
  if (!s) return;
  try { s.setItem(fullKey(key), JSON.stringify({ ver: VERSION, at: Date.now(), value }, replacer)); }
  catch { /* quota or private mode — the form still works, it just forgets */ }
}

export function clearDraft(key) {
  const s = store();
  if (!s) return;
  try { s.removeItem(fullKey(key)); } catch { /* nothing to remove */ }
}

/* Is there something worth reopening a closed form for? The PARENT asks
   this, because a restored draft is useless if the modal it belongs to is
   not on screen. */
export function hasDraft(key) {
  const v = readDraft(key);
  return v !== undefined && v !== null && Object.keys(v).length > 0;
}

export function clearAllDrafts() {
  const s = store();
  if (!s) return;
  for (const k of Object.keys(s)) {
    if (k.startsWith(PREFIX)) { try { s.removeItem(k); } catch { /* ignore */ } }
  }
}

function clearDraftsExcept(keepOwner) {
  const s = store();
  if (!s) return;
  const keep = `${PREFIX}${keepOwner}.`;
  for (const k of Object.keys(s)) {
    if (k.startsWith(PREFIX) && !k.startsWith(keep)) { try { s.removeItem(k); } catch { /* ignore */ } }
  }
}

/* --------------------------------------------------------------------------
   Merging a stored draft into today's blank form.
   --------------------------------------------------------------------------
   Same reasoning as viewState's mergeWithDefaults, and for the same reason:
   a draft written before a release can be missing a field the form has since
   gained, and restoring it verbatim would put `undefined` into a controlled
   input. The BLANK FORM defines the shape; the draft only supplies values.

   The difference from viewState is the seed. A form editing an existing
   record is seeded from that record, so a field the user never touched must
   come from the RECORD, not from a stale draft — which is what
   `onlyChanged` gives: the draft stores only what actually differs from the
   seed, so untouched fields always reflect the current record.
*/
function merge(draft, blank) {
  if (!draft || typeof draft !== "object") return blank;
  if (!blank || typeof blank !== "object") return blank;
  const out = { ...blank };
  for (const k of Object.keys(draft)) {
    if (!(k in blank)) continue;                       // field removed since
    if (isSecretField(k)) continue;                 // never, regardless
    const d = draft[k], b = blank[k];
    if (d === null || d === undefined) continue;
    if (b !== null && b !== undefined && typeof d !== typeof b && !(b instanceof Set)) continue;
    out[k] = d;
  }
  return out;
}

function diff(form, seed, exclude) {
  const out = {};
  for (const k of Object.keys(form)) {
    if (exclude.includes(k) || isSecretField(k)) continue;
    const a = form[k], b = seed?.[k];
    if (a instanceof Set) { if (a.size) out[k] = a; continue; }
    if (typeof File !== "undefined" && a instanceof File) continue;
    /* `"" !== null` and `0 !== ""` would both read as edits on a form seeded
       from a database row where blanks are null. Compared loosely on empties
       so an untouched field is not stored as a change. */
    const empty = v => v === "" || v === null || v === undefined;
    if (empty(a) && empty(b)) continue;
    if (a !== b) out[k] = a;
  }
  return out;
}

/* --------------------------------------------------------------------------
   The hook.
   --------------------------------------------------------------------------
     const [form, setForm, draft] = useFormDraft(key, blankForm, opts);

   `draft.restored` — true when something came back, for the notice.
   `draft.discard()` — back to the blank/seeded form, draft deleted.
   `draft.clear()`   — delete the draft WITHOUT touching the form. Call this
                       on a successful save; otherwise the draft outlives the
                       record it created and reappears the next time the form
                       is opened.
*/
export function useFormDraft(key, blank, { exclude = [], enabled = true } = {}) {
  const seedRef = useRef(blank);
  const [restored, setRestored] = useState(false);

  const [form, setForm] = useState(() => {
    if (!enabled || !key) return blank;
    const d = readDraft(key);
    if (d === undefined) return blank;
    const merged = merge(d, blank);
    return merged;
  });

  /* Announced in an effect rather than during render so the notice appears
     with the restored values rather than one render ahead of them. */
  useEffect(() => {
    if (!enabled || !key) return;
    const d = readDraft(key);
    if (d !== undefined && Object.keys(d).length > 0) setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  /* Only the CHANGES are stored, never the whole record. Two reasons: a form
     editing an existing row would otherwise persist a full copy of that row
     into the browser (an entire user profile, an order with its FOB), and a
     field the user never touched would be frozen at its old value even after
     someone else updated the record. */
  useEffect(() => {
    if (!enabled || !key) return;
    const changes = diff(form, seedRef.current, exclude);
    if (Object.keys(changes).length === 0) clearDraft(key);
    else writeDraft(key, changes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, form, enabled]);

  const discard = useCallback(() => {
    clearDraft(key);
    setForm(seedRef.current);
    setRestored(false);
  }, [key]);

  const clear = useCallback(() => { clearDraft(key); setRestored(false); }, [key]);

  return [form, setForm, { restored, discard, clear }];
}

export const __internals = { PREFIX, VERSION, MAX_AGE_MS, merge, diff, isSecretField, fullKey };
