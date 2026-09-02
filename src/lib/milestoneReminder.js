/* ==========================================================================
   The milestone action reminder.
   ==========================================================================
   This is a PRESENTATION rule and nothing else. It answers one question —
   "does this milestone need me to do something today?" — and it answers it
   from the plan date, the actual date and today's date only.

   It deliberately does NOT read, write, derive or influence
   `order_milestones.status`. Status is a business field the merchandiser
   sets, and it drives the notification engine, the Follow-up Report, the
   Ex-Factory export and the KPI screens. The two concepts answer different
   questions and are kept apart on purpose:

     reminder  "do I need to update or chase this milestone?"   (this file)
     status    "what is the business condition of this milestone?" (the user)

   The consequence the brief asks for falls straight out of that separation:
   entering an actual date clears the reminder even when the work was late,
   while a status of Delayed stays Delayed, because nothing here can change
   it. There is no code path from this file to a write.

   Both the Workbench (live colours) and the printed Follow-up Report
   (historical late marks) import from here, so the two screens can never
   drift apart on what "approaching" means. */

export const REMINDER_WINDOW_DAYS = 5;

export const REMINDER_NONE = "none";
export const REMINDER_SOON = "soon";      // plan is within the window, no actual yet
export const REMINDER_DUE = "due";        // plan is today or has passed, no actual yet

/* UTC throughout. A merchandiser in Dhaka and a manager in Miami must see
   the same colour on the same row; local-midnight arithmetic would put a
   milestone "due today" for one of them and "due tomorrow" for the other. */
export function daysUntil(isoDate, today) {
  if (!isoDate || !today) return null;
  const a = Date.parse(isoDate + "T00:00:00Z");
  const b = Date.parse(today + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((a - b) / 86400000);
}

/* The whole rule, in one place.

     actual present            -> none   (nothing to chase; late or not)
     no plan date              -> none   (nothing to be early or late against)
     plan today or passed      -> due    (orange — needs attention now)
     plan within 5 days        -> soon   (yellow — follow up)
     otherwise                 -> none

   `status` is not a parameter. That is the point. */
export function reminderFor(milestone, today, windowDays = REMINDER_WINDOW_DAYS) {
  if (!milestone) return REMINDER_NONE;
  if (milestone.actual_date) return REMINDER_NONE;
  const d = daysUntil(milestone.plan_date, today);
  if (d == null) return REMINDER_NONE;
  if (d <= 0) return REMINDER_DUE;
  if (d <= windowDays) return REMINDER_SOON;
  return REMINDER_NONE;
}

export function reminderTitle(kind, milestone, today) {
  if (kind === REMINDER_DUE) {
    const d = daysUntil(milestone.plan_date, today);
    return d === 0
      ? "Planned for today and no actual date recorded yet"
      : `Planned ${Math.abs(d)} day${Math.abs(d) === 1 ? "" : "s"} ago and no actual date recorded yet`;
  }
  if (kind === REMINDER_SOON) {
    const d = daysUntil(milestone.plan_date, today);
    return `Planned in ${d} day${d === 1 ? "" : "s"} — follow this up`;
  }
  return "";
}

/* The historical mark for the printed report, which asks a different
   question from the Workbench: not "chase this" but "was it delivered on
   time?". So this one looks only at actual against plan, and says nothing
   at all until an actual exists. */
export function completedLate(milestone) {
  if (!milestone || !milestone.actual_date || !milestone.plan_date) return false;
  return String(milestone.actual_date) > String(milestone.plan_date);
}

export function lateByDays(milestone) {
  if (!completedLate(milestone)) return 0;
  return daysUntil(milestone.actual_date, milestone.plan_date) || 0;
}

/* Today, as an ISO day, in UTC — one definition so every caller agrees. */
export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}
