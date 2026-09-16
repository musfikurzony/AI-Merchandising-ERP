import { factoryVisibleEtd } from "./etdBuffer.js";

/* ==========================================================================
   What an outside user is shown, wherever they are standing.
   ==========================================================================
   v95 answered "the factory can see the real ETD" by locking factory users
   out of the ERP entirely. That was the wrong answer to the right problem,
   and the owner said so plainly: factory people are sometimes GIVEN the
   Workbench on purpose, so they can update their own milestones. Locking
   them out removes a working practice in order to hide a date.

   His own proposal is the better one, and this file is it:

       "for factory user log in, all delivery can show as factory ETD"

   The date is the thing that must not leak — not the screen. So the screen
   stays, the permission grid decides who gets it exactly as it does for
   everyone else, and the ORDER ROW ITSELF is rewritten on the way out of the
   data layer for a viewer who belongs to a factory:

       etd             -> the buffered date
       revised_etd     -> removed entirely
       etd_buffer_days -> removed entirely
       fob             -> removed entirely

   `revised_etd` has to go, not just be replaced: a factory that can see the
   revision can subtract to recover the buffer, and a factory that can see
   the buffer knows exactly how much slack to take back. Removing it is the
   whole point of having a buffer at all.

   --------------------------------------------------------------------------
   WHERE THIS SITS, AND WHAT IT IS WORTH
   --------------------------------------------------------------------------
   It is applied in the seven functions that load order rows, so every screen
   built on them inherits it without each one having to remember. That is its
   strength — a new report gets the rule for free — and it is not a security
   boundary, which is its limit. It rewrites what the APPLICATION hands to
   the page; someone calling PostgREST directly with their own token is
   answered by RLS, not by this file. Migration 40 does that half for the
   factory portal's own view. Both halves are needed and neither is a
   substitute for the other, and that is stated rather than glossed.
*/

let viewer = null;

export function setViewer(profile) {
  viewer = profile || null;
}

export function currentViewer() { return viewer; }

/* Deliberately duplicated in spirit with factoryUser.js and kept in step by
   importing nothing from it: this module must be safe to call from the data
   layer, and a cycle through the routing helpers is how that stops being
   true. Both signals, same as there — a linked code, or a factory role. */
const FACTORY_ROLES = ["factory_admin", "factory_user"];

export function viewerIsFactory(profile = viewer) {
  if (!profile) return false;
  const code = profile.linked_factory_code;
  if (typeof code === "string" && code.trim() !== "") return true;
  return FACTORY_ROLES.includes(profile.role);
}

/* One row. Returns the row untouched for an internal viewer — not a copy —
   so the normal path costs nothing at all. */
export function lensOrder(row) {
  if (!row || !viewerIsFactory()) return row;
  const out = { ...row };
  if ("etd" in out || "revised_etd" in out) {
    /* factoryVisibleEtd reads coalesce(revised_etd, etd) and subtracts the
       buffer. Computed BEFORE revised_etd is dropped, or a revised PO would
       silently fall back to its original date. */
    out.etd = factoryVisibleEtd(row);
  }
  delete out.revised_etd;
  delete out.revised_etd_reason;
  delete out.etd_buffer_days;
  delete out.fob;
  /* A marker the screens can read, so a date that has been moved can say so
     rather than pretending to be the real thing. It is the factory's own
     date, which is exactly what they should be planning against. */
  out.__factoryView = true;
  return out;
}

export function lensOrders(rows) {
  if (!Array.isArray(rows) || !viewerIsFactory()) return rows;
  return rows.map(lensOrder);
}

/* For a nested shape — `{ orders: {...} }` from an embedded select, or an
   array of them. Used where a query joins orders rather than selecting them
   directly, so those paths cannot quietly skip the rule. */
export function lensNested(rows, key = "orders") {
  if (!Array.isArray(rows) || !viewerIsFactory()) return rows;
  return rows.map(r => (r && r[key] ? { ...r, [key]: lensOrder(r[key]) } : r));
}

/* Should this viewer be offered the buffer control, the revised-ETD field,
   or anything else that only means something to the office? */
export function canSeeInternalDateFields(profile = viewer) {
  return !viewerIsFactory(profile);
}

export const __internals = { FACTORY_ROLES };
