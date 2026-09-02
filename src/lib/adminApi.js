import { supabase } from "./supabaseClient.js";

/* Every function here either (a) calls the admin-manage-user Edge Function
   for the handful of actions that genuinely need the service_role key, or
   (b) queries tables directly, relying entirely on RLS to decide what's
   allowed -- never a separate authorization check duplicated in JS. */

async function callAdminFunction(action, payload) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Not signed in");
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-manage-user`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ action, ...payload }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Request failed");
  return body;
}

export const createUser = (fields) => callAdminFunction("create_user", fields);
export const resetPassword = (user_id, target_role) => callAdminFunction("reset_password", { user_id, target_role });
export const forcePasswordChange = (user_id, target_role) => callAdminFunction("force_password_change", { user_id, target_role });
export const setUserActive = (user_id, is_active, target_role) => callAdminFunction("set_active", { user_id, is_active, target_role });
// Permanent, irreversible -- deletes the auth account and cascades to the
// profile. A user who owns real orders (primary_merchandiser_id) will
// correctly fail with a clear foreign-key error instead of silently
// orphaning business data -- surface that message plainly, don't retry
// around it or suggest a workaround.
export const deleteUserPermanently = (user_id, target_role) => callAdminFunction("delete_user", { user_id, target_role });

// --- Direct table access below, RLS-gated, no Edge Function needed ---

export async function listUsers() {
  const { data, error } = await supabase.from("user_directory").select("*").order("full_name");
  if (error) throw error;
  return data;
}

export async function updateUserProfile(user_id, fields) {
  const { error } = await supabase.from("profiles").update(fields).eq("id", user_id);
  if (error) throw error;
}

export async function listRoles() {
  const { data, error } = await supabase.from("roles").select("*").order("label");
  if (error) throw error;
  return data;
}

export async function cloneRole(sourceRoleKey, newRoleKey, newRoleLabel) {
  const { error } = await supabase.rpc("clone_role", {
    source_role_key: sourceRoleKey, new_role_key: newRoleKey, new_role_label: newRoleLabel,
  });
  if (error) throw error;
}

export async function listModulePermissions(role) {
  const { data, error } = await supabase.from("module_permissions").select("*").eq("role", role);
  if (error) throw error;
  return data;
}

export async function upsertModulePermission(role, module_key, action, value) {
  const column = { view: "can_view", add: "can_add", edit: "can_edit", delete: "can_delete", export: "can_export", approve: "can_approve" }[action];
  const { error } = await supabase.from("module_permissions").upsert(
    { role, module_key, [column]: value }, { onConflict: "role,module_key" }
  );
  if (error) throw error;
}

export async function listFinePermissions() {
  const { data, error } = await supabase.from("permissions").select("*").order("key");
  if (error) throw error;
  return data;
}

export async function listRolePermissions(role) {
  const { data, error } = await supabase.from("role_permissions").select("*").eq("role", role);
  if (error) throw error;
  return data;
}

export async function upsertRolePermission(role, permission_key, allowed) {
  const { error } = await supabase.from("role_permissions").upsert(
    { role, permission_key, allowed }, { onConflict: "role,permission_key" }
  );
  if (error) throw error;
}

// --- Per-user overrides ---

export async function listUserOverrides(user_id) {
  const [fine, module_] = await Promise.all([
    supabase.from("user_permission_overrides").select("*").eq("user_id", user_id),
    supabase.from("user_module_permission_overrides").select("*").eq("user_id", user_id),
  ]);
  if (fine.error) throw fine.error;
  if (module_.error) throw module_.error;
  return { finePermissions: fine.data, modulePermissions: module_.data };
}

export async function setFinePermissionOverride(user_id, permission_key, allowed) {
  // allowed === null means "remove the override, go back to inheriting the role"
  if (allowed === null) {
    const { error } = await supabase.from("user_permission_overrides").delete()
      .eq("user_id", user_id).eq("permission_key", permission_key);
    if (error) throw error;
    return;
  }
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("user_permission_overrides").upsert(
    { user_id, permission_key, allowed, granted_by: user?.id }, { onConflict: "user_id,permission_key" }
  );
  if (error) throw error;
}

export async function setModulePermissionOverride(user_id, module_key, action, value) {
  const column = { view: "can_view", add: "can_add", edit: "can_edit", delete: "can_delete", export: "can_export", approve: "can_approve" }[action];
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from("user_module_permission_overrides").upsert(
    { user_id, module_key, [column]: value, granted_by: user?.id }, { onConflict: "user_id,module_key" }
  );
  if (error) throw error;
}

// --- Organization / System Settings ---

export async function getOrganizationSettings() {
  const { data, error } = await supabase.from("organization_settings").select("*").single();
  if (error) throw error;
  return data;
}

export async function updateOrganizationSettings(fields) {
  const { error } = await supabase.from("organization_settings").update(fields).eq("id", true);
  if (!error) return;
  /* fiscal_year_start_month arrives with migration 37. On a deployment that
     has not run it, Postgres rejects the whole UPDATE for one unknown column
     and the administrator loses their company-name edit as well. Retrying
     without that field saves what CAN be saved, and the caller is told which
     part did not stick rather than being shown a generic failure. */
  if (/fiscal_year_start_month/.test(error.message || "") && "fiscal_year_start_month" in fields) {
    const { fiscal_year_start_month, ...rest } = fields;
    const retry = await supabase.from("organization_settings").update(rest).eq("id", true);
    if (retry.error) throw retry.error;
    throw new Error("Saved, except the fiscal year start month — that setting needs migration 37 to be applied first.");
  }
  throw error;
}

export async function listSystemSettings() {
  const { data, error } = await supabase.from("system_settings").select("*").order("key");
  if (error) throw error;
  return data;
}

export async function updateSystemSetting(key, value) {
  const { error } = await supabase.from("system_settings").update({ value }).eq("key", key);
  if (error) throw error;
}

// --- Audit Trail ---

export async function listAuditLog({ orderId, actorId, targetUserId, limit = 100 } = {}) {
  let query = supabase.from("audit_log").select("*").order("created_at", { ascending: false }).limit(limit);
  if (orderId) query = query.eq("order_id", orderId);
  if (actorId) query = query.eq("actor_id", actorId);
  if (targetUserId) query = query.eq("target_user_id", targetUserId);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export const MODULE_KEYS = ["orders", "workbench", "samples", "reports", "kpi_dashboard", "executive_dashboard", "ai_assistant", "crd_monitoring", "shipping_portal", "factory_portal", "administration"];
export const MODULE_ACTIONS = ["view", "add", "edit", "delete", "export", "approve"];
