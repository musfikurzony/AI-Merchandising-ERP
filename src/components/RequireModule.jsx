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
    hasModulePermission(module, action).then(result => {
      if (!cancelled) setAllowed(result);
    });
    return () => { cancelled = true; };
  }, [module, action]);

  if (allowed === null) return <div style={{ padding: 40 }}>Checking access...</div>;
  if (!allowed) return <Navigate to={fallback} replace />;
  return children;
}
