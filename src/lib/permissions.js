import { supabase } from "./supabaseClient.js";

/* This deliberately does NOT reimplement permission logic in JavaScript.
   has_permission() and has_module_permission() already exist as real
   Postgres functions (supabase/02_rls_policies.sql and
   05_administration.sql) that every RLS policy already calls -- calling
   them via RPC here means the UI's "should I show this button" check and
   the database's "will this write actually be allowed" check are the same
   function, not two implementations that could drift apart. */

export async function hasPermission(key) {
  const { data, error } = await supabase.rpc("has_permission", { perm_key: key });
  if (error) { console.error("has_permission RPC failed:", error); return false; }
  return !!data;
}

export async function hasModulePermission(moduleKey, action) {
  const { data, error } = await supabase.rpc("has_module_permission", {
    p_module_key: moduleKey, p_action: action,
  });
  if (error) { console.error("has_module_permission RPC failed:", error); return false; }
  return !!data;
}

/* Role -> landing route, per docs/01_Administration_User_Access_Management.md
   Section 6. Kept here as application-level routing logic (not a database
   table) since it's a UI concern -- see that doc for why. */
export const ROLE_LANDING_ROUTE = {
  super_admin: "/dashboard", admin: "/dashboard",
  management: "/executive-dashboard", manager: "/executive-dashboard",
  merchandiser: "/dashboard",
  shipping: "/shipping", commercial: "/shipping",
  qa: "/dashboard",
  factory_admin: "/factory", factory_user: "/factory",
  read_only: "/executive-dashboard",
};
