import { useEffect, useRef, useState } from "react";
import { supabase } from "./supabaseClient.js";
import { clearAllViewState } from "./viewState.js";
import { clearAllDrafts, setDraftOwner } from "./formDraft.js";

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

  /* Which user the route tree was built for. Compared against the user on
     every auth event, because the question that decides whether to unmount is
     "is this a different person?" and nothing else. */
  const loadedUserRef = useRef(null);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      setSession(session);
      if (session) {
        loadedUserRef.current = session.user.id;
        setDraftOwner(session.user.id);
        await loadProfile(session.user.id);
      }
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, session) => {
      setSession(session);
      if (session) {
        /* Setting loading=true unmounts the ENTIRE route tree — App.jsx
           renders a bare "Loading..." while it is true — and remounting is
           what throws away whatever the user had on screen.
           
           This used to exempt one event by name, TOKEN_REFRESHED, which the
           SDK emits when a backgrounded tab regains focus. That fixed the
           symptom it was written for and left the rest: supabase-js also
           emits SIGNED_IN when it recovers a session on visibility change,
           and INITIAL_SESSION on some paths, and any of those would tear the
           page down on a simple tab switch.
           
           So the test is no longer "which event is this" but the question
           that actually matters: IS THIS A DIFFERENT PERSON? Only a change of
           user justifies rebuilding the app. The profile is still refreshed
           on every event either way, so a role change while away is picked up
           without the screen resetting. */
        const sameUser = loadedUserRef.current === session.user.id;
        loadedUserRef.current = session.user.id;
        setDraftOwner(session.user.id);
        if (!sameUser) setLoading(true);
        await loadProfile(session.user.id);
        if (!sameUser) setLoading(false);
      } else {
        loadedUserRef.current = null;
        setDraftOwner(null);
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
    /* Wipe the per-screen view state before ending the session. Two people
       share a machine more often than anyone plans for, and the second one
       should not open the Workbench to the first one's factory filter and
       wonder where the rest of the order book went. The date-format
       PREFERENCE is deliberately left alone — it belongs to the browser, not
       to the session. */
    clearAllViewState();
    /* Drafts hold real business data — a half-written user record, an
       unfinished order edit. They must not survive the person who typed
       them leaving the machine. */
    clearAllDrafts();
    await supabase.auth.signOut();
  }

  return { session, profile, loading, signIn, signOut };
}
