import { supabase } from "./supabaseClient.js";
import { buildReportDataset } from "./reportsApi.js";
import { fetchAllByIds, countByIds, reconcile, integrityOf } from "./supabaseFetch.js";

/* ==========================================================================
   AI Assistant — the guidance engine
   ==========================================================================

   What this is, stated plainly because the word "AI" invites the wrong
   assumption: this is a DETERMINISTIC RULES ENGINE over the user's own
   order, milestone, CRD and shipment data. It does not call a language
   model, it invents nothing, and every number it shows can be traced to a
   row in the database. That is deliberate — an assistant that tells a
   merchandiser to chase the wrong PO is worse than no assistant, and a
   plausible-sounding sentence generated from nothing is exactly how that
   happens. (A clean adapter for a real LLM is left at the bottom of this
   file for free-text questions later; the guidance itself stays computed.)

   Three design rules the whole file follows:

   1. NEVER GUESS A MILESTONE KEY. The T&A catalog (`tna_milestone_types`)
      is configurable per deployment, so rules that need "the fit sample
      milestone" RESOLVE it against the real catalog. If a deployment has
      no matching milestone, the rule reports itself as unavailable, with
      the reason — it never silently returns an empty card that looks like
      "nothing to do".

   2. EVERY CARD ENDS IN AN IMPERATIVE. "4 orders have no factory" is a
      statistic. "Assign a factory to these 4 orders — they can't start
      T&A until you do" is guidance. The whole point of this screen is the
      second one.

   3. THE SAME RULE, ONE PLACE. Anything about lateness reuses
      `attentionList`-style logic and the existing compute functions, so
      the assistant and the Executive Dashboard can never disagree about
      what is late.
   ========================================================================== */

export const AUDIENCES = [
  ["merchandiser", "Merchandiser", "Your own follow-ups, in the order they need doing"],
  ["shipping", "Shipping", "What is ready to ship, invoice and document"],
  ["management", "Management", "Where the business needs a call made today"],
];

/* THE role -> audience mapping. The Dashboard imports this rather than
   keeping its own: when the two disagreed, an administrator saw 134
   critical POs on their Dashboard and 130 in the AI Assistant, because one
   screen had put them in the management scope and the other in the
   merchandiser scope. Both numbers were correct for their own scope, which
   is exactly the kind of "correct but contradictory" that destroys trust in
   a system. Administrators default to the management view because that is
   the question they open the ERP to ask; they can still switch. */
export function defaultAudienceForRole(role) {
  if (["shipping", "commercial"].includes(role)) return "shipping";
  if (["management", "manager", "read_only", "admin", "super_admin"].includes(role)) return "management";
  return "merchandiser";
}

export function canSwitchAudience(role) {
  return ["admin", "super_admin", "manager", "management"].includes(role);
}

/* --- milestone key resolution -------------------------------------------
   Matched against both the catalog key and its human label, most specific
   pattern first. Returns null when a deployment genuinely has no such
   milestone — the caller then reports the rule as unavailable rather than
   pretending it passed. */
const MILESTONE_PATTERNS = {
  fitSample:     [/fit[_\s-]*sample/i, /^fit$/i],
  ppSample:      [/\bpp[_\s-]*sample/i, /pre[_\s-]*production[_\s-]*sample/i, /^pp$/i],
  topSample:     [/\btop[_\s-]*sample/i, /^top$/i],
  labDip:        [/lab[_\s-]*dip/i],
  strikeOff:     [/strike[_\s-]*off/i, /handloom/i],
  fabricEtd:     [/fab(ric)?[_\s-]*etd/i],
  fabricInhouse: [/fab(ric)?[_\s-]*in[_\s-]*house/i],
  prodStart:     [/prod(uction)?[_\s-]*start/i, /\bpcd\b/i],
  exFactory:     [/ex[_\s-]*factory/i],
};

export function resolveMilestoneKeys(milestoneTypes) {
  const resolved = {};
  for (const [name, patterns] of Object.entries(MILESTONE_PATTERNS)) {
    let hit = null;
    for (const p of patterns) {
      hit = (milestoneTypes || []).find(t => p.test(t.key) || p.test(t.label || ""));
      if (hit) break;
    }
    resolved[name] = hit ? { key: hit.key, label: hit.label || hit.key } : null;
  }
  return resolved;
}

/* --- data ---------------------------------------------------------------- */

export async function buildAdvisorDataset(filters = {}) {
  const base = await buildReportDataset(filters);
  const orderIds = base.orders.map(o => o.id);

  /* THE most truncation-prone fetch in the app: one order carries a dozen
     or more milestone rows, so a few hundred orders already exceed
     PostgREST's 1,000-row ceiling. Before paging, a missing milestone row
     was indistinguishable from an unrecorded one — which is exactly how
     "Fit Sample not submitted" could read 195 out of 217 orders. Now paged,
     chunked and reconciled against an exact COUNT. */
  const [milestones, milestoneCount, typesRes] = await Promise.all([
    fetchAllByIds("order_milestones",
      "order_id, milestone_key, color_way_name, plan_date, actual_date, status, updated_at",
      "order_id", orderIds, { order: "order_id" }),
    countByIds("order_milestones", "order_id", orderIds),
    supabase.from("tna_milestone_types").select("key, label, critical_path, sequence_order, is_active").order("sequence_order"),
  ]);
  if (typesRes.error) throw typesRes.error;

  const milestoneTypes = (typesRes.data || []).filter(t => t.is_active !== false);
  const milestonesByOrder = new Map();
  for (const m of milestones) {
    if (!milestonesByOrder.has(m.order_id)) milestonesByOrder.set(m.order_id, []);
    milestonesByOrder.get(m.order_id).push(m);
  }

  const integrity = integrityOf([
    ...(base.integrity?.checks || []),
    reconcile("T&A milestones", milestones.length, milestoneCount.count, milestoneCount.error),
  ]);

  return { ...base, milestones, milestonesByOrder, milestoneTypes, keys: resolveMilestoneKeys(milestoneTypes), integrity };
}

/* The rule engine that used to live here (generateGuidance and its ~20 rule
   functions) was retired in v84. Every alert is now produced by ONE typed
   engine, src/lib/notificationsApi.js, which the Dashboard, the AI Assistant,
   the Reports Centre and the Excel/PDF exports all read from. Keeping a second
   set of thresholds here would have been exactly the drift the control-tower
   brief forbids: Reports Centre saying 17 overdue POs while the AI Assistant
   says 18. This file now does two things only — load the dataset, and answer
   the shell's badge count. */

/* ==========================================================================
   The adapter left open for a real language model later.
   ==========================================================================
   Deliberately NOT wired to anything: putting an API key in this bundle
   would ship it to every browser that loads the app. When free-text
   questions are wanted, the implementation goes in a Supabase Edge
   Function that holds the key server-side and calls this same engine for
   the facts, so the model summarises computed numbers rather than
   inventing them. */
export async function askAssistant(/* question, context */) {
  return {
    available: false,
    reason: "Free-text questions need a server-side key (a Supabase Edge Function). The guidance on this screen is computed from your data and needs no external service.",
  };
}

/* --- the header bell -------------------------------------------------------
   Two cheap head-counts, not the whole engine: loading every order and
   milestone on every page render to decorate a bell would be an absurd
   cost. These two are the checks that are both unambiguous and cheap
   (past ETD and not shipped; no factory assigned), and the tooltip says
   exactly what the number counts so it can never be read as "everything
   is fine" when it only covers two rules. */
export async function getAlertBadge({ userId = null, onlyMine = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const base = () => {
    let q = supabase.from("orders").select("*", { count: "exact", head: true })
      .eq("is_deleted", false).neq("status", "cancelled").neq("status", "shipped");
    if (onlyMine && userId) q = q.eq("primary_merchandiser_id", userId);
    return q;
  };
  const [pastEtd, noFactory] = await Promise.all([
    base().lt("etd", today),
    base().is("factory_code", null),
  ]);
  const a = pastEtd.error ? 0 : (pastEtd.count || 0);
  const b = noFactory.error ? 0 : (noFactory.count || 0);
  return {
    total: a + b,
    pastEtd: a,
    noFactory: b,
    title: `${a} order${a === 1 ? "" : "s"} past ETD and not shipped · ${b} with no factory assigned — open the AI Assistant for the full picture`,
  };
}
