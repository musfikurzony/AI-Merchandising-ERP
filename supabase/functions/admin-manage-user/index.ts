// supabase/functions/admin-manage-user/index.ts
//
// The ONLY place in this entire system that touches the service_role key.
// Deploy via: supabase functions deploy admin-manage-user
// (needs the Supabase CLI + your project linked -- see PHASE2_SETUP_GUIDE.md)
//
// Called from the client (src/lib/adminApi.js) with the caller's own JWT in
// the Authorization header. Every action re-checks has_permission() using
// that JWT before doing anything privileged -- so even if this function's
// URL leaked, a non-Admin caller still can't use it, because the same RLS-
// backing permission functions the rest of the app relies on are what gate
// access here too. No separate authorization logic to keep in sync.
//
// Every action also writes an audit_log entry (target_user_id = the
// affected account, actor_id = the caller) -- see migration 12 for the
// column this depends on.
//
// CORS: Supabase Edge Functions do NOT add CORS headers automatically --
// unlike the PostgREST/Data API, this is plain Deno.serve, so every single
// response (OPTIONS preflight, success, and every error path) has to
// include them explicitly, or the browser blocks the request before it
// ever reaches the handler logic below. This is unrelated to
// authentication/authorization -- corsHeaders are response metadata only,
// added on top of the existing permission checks, never a replacement for
// them.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function randomTempPassword() {
  // Not shown to the caller in logs -- returned once in the response body
  // for the Admin to relay to the new/reset user directly (verbally, on
  // paper, however your office does it -- never via this system's email,
  // per the no-email requirement).
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let pw = "";
  for (let i = 0; i < 12; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  return pw;
}

export async function handleRequest(req) {
  // MUST be the very first check -- before any auth/body parsing/business
  // logic. The browser's preflight OPTIONS request carries none of the
  // real request's auth or body, it only asks "are you going to allow
  // this cross-origin call at all" -- answering anything other than a
  // plain 200 + these headers here is what produces the exact error
  // reported: "No 'Access-Control-Allow-Origin' header is present."
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "POST only" }, 405);
  }

  const authHeader = req.headers.get("Authorization") || "";
  const callerJwt = authHeader.replace("Bearer ", "");
  if (!callerJwt) {
    return jsonResponse({ error: "Missing Authorization header" }, 401);
  }

  // Client bound to the CALLER's JWT -- used to check their permission via
  // the same has_permission() function every RLS policy already uses, and
  // to identify who they are for audit logging.
  const callerClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: `Bearer ${callerJwt}` } },
  });

  // Admin client, service_role -- never exposed to the browser, only used
  // here, only after the permission check below passes.
  const adminClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: { user: callerUser }, error: callerErr } = await callerClient.auth.getUser();
  if (callerErr || !callerUser) {
    return jsonResponse({ error: "Could not identify caller" }, 401);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }
  const { action } = body;

  async function requirePermission(key) {
    const { data, error } = await callerClient.rpc("has_permission", { perm_key: key });
    if (error || !data) throw new Error(`Not authorized (needs '${key}')`);
  }

  async function requireAccountPermission(role) {
    if (role === "factory_admin" || role === "factory_user") await requirePermission("manage_factory_accounts");
    else if (role === "shipping" || role === "commercial") await requirePermission("manage_shipping_accounts");
    else await requirePermission("manage_users");
  }

  async function logAudit(targetUserId, actionName, fieldName, oldValue, newValue) {
    // Uses adminClient deliberately -- this is internal bookkeeping the
    // function itself performs, not a client-facing table write; RLS on
    // audit_log still applies normally to everyone reading it afterward.
    await adminClient.from("audit_log").insert({
      target_user_id: targetUserId, actor_id: callerUser.id,
      action: actionName, field_name: fieldName || null,
      old_value: oldValue != null ? String(oldValue) : null,
      new_value: newValue != null ? String(newValue) : null,
    });
  }

  try {
    if (action === "create_user") {
      const { email, full_name, role, employee_id, department, designation, mobile, linked_factory_code } = body;
      await requireAccountPermission(role);

      // Pre-check employee_id uniqueness BEFORE creating anything. Without
      // this, a duplicate employee_id would let the auth user and its
      // trigger-defaulted profile (role='merchandiser', per
      // handle_new_user()) get created successfully, then fail on the
      // second UPDATE step below -- leaving a real account stuck at the
      // wrong role until someone notices and edits it. Confirmed
      // empirically before writing this fix: that exact sequence was
      // reproduced against a real Postgres instance. The unique constraint
      // itself is untouched -- this only avoids the account ever reaching
      // a half-created state in the first place.
      // employee_id normalized to null when blank -- UNIQUE treats "" as a
      // real, colliding value (unlike NULL, which is never considered a
      // duplicate of another NULL), so two users both left without an
      // employee ID would otherwise always collide on the empty string,
      // not just genuine duplicates. Confirmed empirically before fixing.
      const normalizedEmpId = employee_id || null;
      if (normalizedEmpId) {
        const { data: existingEmp } = await adminClient.from("profiles").select("id").eq("employee_id", normalizedEmpId).maybeSingle();
        if (existingEmp) {
          return jsonResponse({ error: `Employee ID "${normalizedEmpId}" is already in use by another account.` }, 409);
        }
      }

      const tempPassword = randomTempPassword();
      const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
        email, password: tempPassword, email_confirm: true, // no email sent -- this IS the "Auto Confirm" equivalent, via API
        user_metadata: { full_name },
      });
      if (createErr) throw createErr;

      // The handle_new_user() trigger (05_administration.sql) already
      // inserted a default profiles row -- update it with the real details
      // rather than inserting a second row.
      // linked_factory_code is normalized here as a safety net -- the
      // frontend already sends null for "no factory yet," but this
      // Edge Function is the last checkpoint before the database write,
      // and an empty string here would violate profiles_linked_factory_code_fkey
      // (the FK correctly permits NULL, but "" is a real, non-null value
      // that Postgres must validate against factories.code).
      const { error: updateErr } = await adminClient
        .from("profiles")
        .update({ full_name, role, employee_id: normalizedEmpId, department, designation, mobile, linked_factory_code: linked_factory_code || null, must_change_password: true })
        .eq("id", created.user.id);
      if (updateErr) {
        // Safety net for any OTHER reason this update could fail (the
        // employee_id pre-check above already covers the common case) --
        // roll back the auth user rather than leave an orphaned,
        // wrongly-defaulted account behind. Deleting it cascades to remove
        // the trigger-created profile row too (profiles.id references
        // auth.users(id) on delete cascade), confirmed empirically.
        await adminClient.auth.admin.deleteUser(created.user.id);
        throw updateErr;
      }

      await logAudit(created.user.id, "user.created", "role", null, role);

      return jsonResponse({ user_id: created.user.id, temp_password: tempPassword }, 200);
    }

    if (action === "reset_password") {
      const { user_id, target_role } = body;
      await requireAccountPermission(target_role);

      const tempPassword = randomTempPassword();
      const { error: pwErr } = await adminClient.auth.admin.updateUserById(user_id, { password: tempPassword });
      if (pwErr) throw pwErr;

      await adminClient.from("profiles").update({ must_change_password: true }).eq("id", user_id);
      await logAudit(user_id, "user.password_reset", null, null, null);

      return jsonResponse({ temp_password: tempPassword }, 200);
    }

    if (action === "force_password_change") {
      // Distinct from reset_password: doesn't generate/replace the user's
      // current password, just requires them to set a new one at next
      // login (e.g. a routine security policy nudge, not "I forgot mine").
      const { user_id, target_role } = body;
      await requireAccountPermission(target_role);

      const { error } = await adminClient.from("profiles").update({ must_change_password: true }).eq("id", user_id);
      if (error) throw error;
      await logAudit(user_id, "user.forced_password_change", "must_change_password", "false", "true");

      return jsonResponse({ ok: true }, 200);
    }

    if (action === "set_active") {
      const { user_id, is_active, target_role } = body;
      await requireAccountPermission(target_role);

      const { error } = await adminClient.from("profiles").update({ is_active }).eq("id", user_id);
      if (error) throw error;
      // Deactivating in Auth too, so a deactivated user's existing session
      // (if any) can't keep making authenticated requests -- RLS already
      // blocks them via is_active_user(), this just also stops new logins.
      if (!is_active) await adminClient.auth.admin.updateUserById(user_id, { ban_duration: "876000h" }); // ~100 years
      else await adminClient.auth.admin.updateUserById(user_id, { ban_duration: "none" });

      await logAudit(user_id, is_active ? "user.activated" : "user.deactivated", "is_active", !is_active, is_active);

      return jsonResponse({ ok: true }, 200);
    }

    if (action === "delete_user") {
      // Permanent, irreversible -- deletes the auth.users row, which
      // cascades to profiles (Migration 01: profiles.id references
      // auth.users(id) on delete cascade). audit_log.actor_id and
      // order_permissions.granted_by survive with the reference nulled
      // (Migration 22) -- history isn't lost, just detached. A user who
      // owns real orders (orders.primary_merchandiser_id, no cascade by
      // design) will correctly fail with a foreign key error rather than
      // silently orphan business data -- that's protecting real data, not
      // a bug, and the client is expected to show that error plainly
      // rather than work around it.
      const { user_id, target_role } = body;
      await requireAccountPermission(target_role);

      const { data: targetProfile } = await adminClient.from("profiles").select("full_name").eq("id", user_id).single();

      const { error } = await adminClient.auth.admin.deleteUser(user_id);
      if (error) throw error;

      // Can't use the standard logAudit() helper here -- it sets
      // target_user_id to the affected user's id, but that row no longer
      // exists in profiles at this point (the delete above already
      // removed it), so a normal insert would fail the same foreign key
      // constraint that (correctly) protects every other reference to
      // profiles. target_user_id is left null; the name is preserved as
      // plain text in old_value instead, so the audit trail still shows
      // who was deleted even though the row itself is gone.
      await adminClient.from("audit_log").insert({
        target_user_id: null, actor_id: callerUser.id, action: "user.deleted",
        field_name: "account", old_value: targetProfile?.full_name || user_id, new_value: null,
      });

      return jsonResponse({ ok: true }, 200);
    }

    return jsonResponse({ error: `Unknown action: ${action}` }, 400);
  } catch (err) {
    return jsonResponse({ error: err.message || String(err) }, 403);
  }
}

Deno.serve(handleRequest);
