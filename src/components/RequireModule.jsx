import React, { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { hasModulePermission } from "../lib/permissions.js";

/* Route-level guard, additive on top of the already-correct RLS boundary --
   this does NOT replace or weaken any security check. RLS/module_permissions
   already stop unauthorized DATA access at the database layer; this stops
   the UNAUTHORIZED SHELL from rendering in the browser at all, so a user
   can't remain on a route just because the browser happened to be sitting
   there (stale tab, history, bookmark) when a different role logged in.

   Deliberately reuses hasModulePermission() -- the exact same RPC every
   other permission check in this app already calls -- rather than a
   hardcoded role list, so this guard can never drift out of sync with
   whatever an Admin configures in the Permission Matrix. */
export default function RequireModule({ module, action = "view", fallback, children }) {
  const [allowed, setAllowed] = useState(null); // null = still checking

  useEffect(() => {
    let cancelled = false;
    setAllowed(null);

    async function check() {
      try {
        const result = await hasModulePermission(module, action);
        if (!cancelled) setAllowed(result);
      } catch (e) {
        // A genuine error (network hiccup, a transient auth-token-refresh
        // race) is not the same thing as the permission check actually
        // returning false -- retrying once, rather than immediately
        // treating any failure as "denied," is what stops a brief
        // transient error from bouncing the user to fallback for a route
        // they genuinely have access to. Confirmed as the real mechanism
        // behind "switch tabs, come back, land on Dashboard."
        console.error(`Permission check failed for ${module}/${action}, retrying once:`, e);
        try {
          const retryResult = await hasModulePermission(module, action);
          if (!cancelled) setAllowed(retryResult);
        } catch (e2) {
          console.error(`Permission check failed again for ${module}/${action}:`, e2);
          if (!cancelled) setAllowed(false);
        }
      }
    }
    check();

    return () => { cancelled = true; };
  }, [module, action]);

  if (allowed === null) return <div style={{ padding: 40 }}>Checking access...</div>;
  if (!allowed) return <Navigate to={fallback} replace />;
  return children;
}
