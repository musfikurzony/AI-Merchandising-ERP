import { createClient } from "@supabase/supabase-js";

/* ==========================================================================
   Where the Supabase connection details come from.
   ==========================================================================
   Two sources, tried in this order:

     1. window.__ERP_CONFIG__ — set by `config.js`, a plain file sitting
        beside index.html in the deployed folder. It is read at RUNTIME.
     2. import.meta.env — Vite's build-time variables, from .env.local
        locally or from the build settings of a CI/Cloudflare build.

   The runtime file exists because of how this gets deployed. A Vite build
   welds VITE_* values into the JavaScript bundle at the moment it is built,
   which means a pre-built folder can only ever talk to the project it was
   built against. Uploading a finished build straight to Cloudflare — no
   GitHub, no build step — then becomes impossible unless whoever builds it
   already holds the keys.

   With config.js the same built folder works anywhere: change two lines in
   a small text file and reload. No rebuild, no redeploy pipeline, and
   nothing secret in the bundle.

   Nothing here is a secret. The anon key is designed to be public and is
   already visible in the shipped JavaScript of every Supabase web app —
   Row Level Security is what actually decides who can read and write what.
   The service_role key is never used in the browser; it lives only inside
   the admin-manage-user Edge Function.

   The build-time path is kept as a fallback so the existing GitHub →
   Cloudflare build keeps working exactly as it does today, unchanged. */

const runtime = (typeof window !== "undefined" && window.__ERP_CONFIG__) || {};
const build = typeof import.meta !== "undefined" && import.meta.env ? import.meta.env : {};

/* A placeholder that was never filled in is worse than a missing value: it
   produces a real-looking URL that fails at the first query with an opaque
   network error. Treated as absent so the message below is the one people
   actually see. */
const PLACEHOLDER = /your-project|your-anon|YOUR_|REPLACE_ME|\.\.\./i;
const usable = v => (typeof v === "string" && v.trim() && !PLACEHOLDER.test(v) ? v.trim() : null);

const url = usable(runtime.supabaseUrl) || usable(build.VITE_SUPABASE_URL);
const anonKey = usable(runtime.supabaseAnonKey) || usable(build.VITE_SUPABASE_ANON_KEY);

export const configSource = usable(runtime.supabaseUrl) ? "config.js" : (url ? "build" : "none");

if (!url || !anonKey) {
  /* Loud failure on purpose — a silently-missing value here would otherwise
     surface as a confusing "fetch failed" deep inside a screen rather than an
     obvious, fixable message at startup. The message names the file to edit,
     because the person hitting this is usually deploying, not developing. */
  const missing = [!url && "supabaseUrl", !anonKey && "supabaseAnonKey"].filter(Boolean).join(" and ");
  throw new Error(
    `Supabase is not configured — ${missing} ${missing.includes("and") ? "are" : "is"} missing or still a placeholder.\n\n` +
    "If you uploaded this folder to Cloudflare: open config.js next to index.html and fill in the two values from your " +
    "Supabase project's Settings → API page (Project URL and the anon/public key), then upload again.\n\n" +
    "If you are running locally: copy .env.example to .env.local and fill in VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY."
  );
}

export const supabase = createClient(url, anonKey);
