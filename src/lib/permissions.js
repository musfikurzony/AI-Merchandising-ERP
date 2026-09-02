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
  if (error) throw error;
  return !!data;
}

export async function hasModulePermission(moduleKey, action) {
  const { data, error } = await supabase.rpc("has_module_permission", {
    p_module_key: moduleKey, p_action: action,
  });
  if (error) throw error;
  return !!data;
}

/* Role -> landing route, per docs/01_Administration_User_Access_Management.md
   Section 6. Kept here as application-level routing logic (not a database
   table) since it's a UI concern -- see that doc for why.

   From v86 every ERP role lands on /dashboard. The Dashboard itself is now
   role-aware: it picks a management, merchandiser or shipping body from the
   role and gates each section by module permission. Sending management to a
   different ROUTE was the old way of personalising the landing page, and it
   meant three half-finished landing screens instead of one good one.

   Factory users are the deliberate exception: their portal is a genuinely
   different application reading a restricted view, not a variant of this
   shell. */
export const ROLE_LANDING_ROUTE = {
  super_admin: "/dashboard", admin: "/dashboard",
  management: "/dashboard", manager: "/dashboard",
  merchandiser: "/dashboard",
  shipping: "/dashboard", commercial: "/dashboard",
  qa: "/dashboard",
  factory_admin: "/factory", factory_user: "/factory",
  read_only: "/dashboard",
};
