import { viewerIsFactory } from "./viewerLens.js";

/* ==========================================================================
   Recognising an outside user, for the SCREENS.
   ==========================================================================
   `viewerLens.js` holds the same predicate for the DATA layer and is the one
   that rewrites the rows. This file is the UI-facing half: it answers "should
   this control be on the page for this person", and it exists separately so
   the data layer never has to import anything that knows about routing.

   --------------------------------------------------------------------------
   WHAT CHANGED IN v96, AND WHY
   --------------------------------------------------------------------------
   v95 used this to lock factory users out of the ERP entirely — their route
   tree was never built. The reasoning was that an outside company has no
   business inside the order book, and one mis-ticked permission box should
   not be able to put them there.

   The owner corrected the premise: factory people are sometimes given the
   Workbench **on purpose**, so they can update their own milestones. A rule
   that removes a working practice in order to hide a date is solving the
   wrong problem with the wrong tool.

   So access went back to the permission grid, where it belongs — an
   administrator decides what each factory account may open, screen by
   screen, exactly as for a colleague — and the thing that is protected is
   the DATE, everywhere, rather than the screen. See `viewerLens.js`.

   What remains here is the narrower, still-correct part: certain CONTROLS
   are meaningless or harmful on an outside user's screen whatever their
   permissions say, and `canSeeInternalDates()` is how a screen asks.
*/

export const FACTORY_ROLES = ["factory_admin", "factory_user"];

export function isFactoryUser(profile) {
  return viewerIsFactory(profile);
}

/* The factory's own code, normalised, or null. Used in the portal header so
   a factory user can see which factory they are signed in as — several of
   the people using this portal work for a group with more than one unit. */
export function factoryCodeOf(profile) {
  const code = profile?.linked_factory_code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

/* Guard for anything that only means something inside the office: the real
   ETD, the revised ETD, the revision reason, the buffer control, FOB.

   Written as "may this person see it" rather than "hide it from that person"
   so a new screen that forgets to ask fails CLOSED at the call site:
   `canSeeInternalDates(profile) && <BufferControl/>` reads wrong when the
   guard is missing, whereas `!isFactoryUser(profile) && ...` reads fine and
   is easy to leave out.

   The buffer is the sharpest of these. Showing a factory "you are being
   shown a date 13 days early" is worse than never having had a buffer,
   because it tells them exactly how much slack to take back. */
export function canSeeInternalDates(profile) {
  return !isFactoryUser(profile);
}
