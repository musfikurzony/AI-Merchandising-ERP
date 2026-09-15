/* ==========================================================================
   Who is an OUTSIDE user, decided by identity rather than by configuration.
   ==========================================================================
   The report: a factory user signed in and could see the order book — real
   ETD, revised ETD, and the buffer that was supposed to be hiding the real
   ETD from exactly that person.

   The immediate cause was a permission grid with too many boxes ticked for
   the Factory User role. Fixing those boxes fixes today's symptom. It does
   not fix the class of bug, because the grid is edited by hand, by people,
   in a screen that makes every module look equally grantable — and one
   mis-click on the wrong row hands an outside company the entire order book
   including the FOB it must never see.

   So the question this file answers is deliberately NOT "what has this user
   been granted". It is "is this person from outside the company", which is
   a fact about who they are, not a setting. Someone linked to a factory gets
   the factory portal and nothing else, whatever the grid says. The grid can
   still take things AWAY from them — it can never add.

   --------------------------------------------------------------------------
   TWO SIGNALS, EITHER ONE IS ENOUGH
   --------------------------------------------------------------------------
   `linked_factory_code` is the real one: it is what scopes their rows in the
   database, so a user who has it is, by definition, a user the database
   already treats as belonging to one factory.

   The factory ROLES are checked too, as a second, independent signal. A
   factory_user whose factory code has not been filled in yet is still a
   factory user; they should see an empty portal, not the order book. Two
   signals OR'd together means BOTH have to be wrong before anything leaks,
   and they are set in different places by different actions.

   --------------------------------------------------------------------------
   WHAT THIS IS NOT
   --------------------------------------------------------------------------
   This is a guard in a browser. It decides what renders. It is not the
   security boundary and must never be described as one: a determined user
   with a valid token can call the API directly and the only thing standing
   in front of the data there is RLS. This closes the accidental door — the
   mis-ticked checkbox, the stale tab, the pasted URL — and that is worth
   having on its own. The database work is tracked separately.
*/

export const FACTORY_ROLES = ["factory_admin", "factory_user"];

export function isFactoryUser(profile) {
  if (!profile) return false;
  const code = profile.linked_factory_code;
  if (typeof code === "string" && code.trim() !== "") return true;
  return FACTORY_ROLES.includes(profile.role);
}

/* The factory's own code, normalised, or null. Used for the portal header so
   a factory user can see at a glance which factory they are signed in as —
   several of the people using this portal work for a group with more than
   one unit. */
export function factoryCodeOf(profile) {
  const code = profile?.linked_factory_code;
  return typeof code === "string" && code.trim() ? code.trim() : null;
}

/* Guard for anything that renders a date or an amount an outside company
   must not see. Written as "may this person see it" rather than "hide it
   from that person" so a new screen that forgets to ask fails CLOSED at the
   call site: `canSeeInternalDates(profile) && <RealEtd/>` reads wrong when
   the guard is missing, whereas `!isFactoryUser(profile) && ...` reads fine
   and is easy to leave out.

   Covers: the real ETD, the revised ETD, the buffer control and anything
   derived from them (slip days, on-time flags computed against the true
   date). The buffer is the sharpest of these — showing a factory "you are
   being shown a date 13 days early" is worse than never having had a buffer,
   because it tells them precisely how much slack to take back. */
export function canSeeInternalDates(profile) {
  return !isFactoryUser(profile);
}
