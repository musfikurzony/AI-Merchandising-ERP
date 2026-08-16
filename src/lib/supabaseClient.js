import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Loud failure on purpose -- a silently-missing env var here would
  // otherwise surface as a confusing "fetch failed" deep inside a screen
  // instead of an obvious, fixable message at startup.
  throw new Error(
    "Missing Supabase env vars. Copy .env.example to .env.local and fill in " +
    "VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY from your Supabase project's " +
    "Settings -> API page."
  );
}

export const supabase = createClient(url, anonKey);
