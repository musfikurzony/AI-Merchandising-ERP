import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient.js";

/* Real session handling -- no mock users, no hardcoded roles. On sign-in,
   also fetches the profile row (role, must_change_password, etc.) since
   almost every screen needs it immediately.

   `loading` only clears once we genuinely know the final state -- either
   there's no session at all, or (when there is one) the profile fetch has
   actually finished. Confirmed as a real bug: the previous version set
   loading=false the moment getSession() resolved, without waiting for the
   separate, un-awaited profile fetch -- for the ~1 second that fetch took,
   the app saw "session exists, profile still null" and rendered "no
   profile row -- contact an Administrator," a real account state, even
   though the real profile was still simply loading. */
export function useSession() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  async function loadProfile(userId) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, full_name, role, is_active, must_change_password, linked_factory_code, roles(label)")
      .eq("id", userId)
      .single();
    if (error) {
      console.error("Failed to load profile:", error);
      setProfile(null);
      return;
    }
    // Flatten the embedded join so callers can use profile.role_label
    // directly, same shape as user_directory already exposes elsewhere.
    setProfile({ ...data, role_label: data.roles?.label });
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session);
      if (session) await loadProfile(session.user.id);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setSession(session);
      if (session) {
        setLoading(true);
        await loadProfile(session.user.id);
        setLoading(false);
      } else {
        setProfile(null);
      }
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  async function signIn(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  }
  async function signOut() {
    await supabase.auth.signOut();
  }

  return { session, profile, loading, signIn, signOut };
}
