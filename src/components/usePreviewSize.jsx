/* React itself, not just the hooks: this file contains JSX, and under the
   classic transform JSX becomes React.createElement, which needs React in
   scope. Vite is configured with the automatic runtime so the app build was
   happy — the headless harness, which uses esbuild's classic transform, threw
   "React is not defined" the moment the button rendered. Importing it keeps
   both honest, and matches every other component in the tree. */
import React, { useCallback, useEffect, useState } from "react";

/* ==========================================================================
   Maximise, for every preview.
   ==========================================================================
   Excel and PDF previews open at a comfortable reading width, which is right
   for a glance and wrong for checking a wide report — an export with thirty
   columns is exactly the thing you most need the whole screen for.

   So every preview gets the same control, from one place: a maximise toggle
   in the header, `F` or `M` to toggle it, Escape to close. Living in a hook
   rather than being copied into each modal means the Excel preview, the PDF
   preview and anything added later behave identically, and the shortcut is
   learned once.

   The choice is remembered per browser: someone who works maximised should
   not have to press it on every export. Storage is wrapped because a private
   window or blocked site data makes localStorage throw on access, not just
   return null — and a preview that cannot open because of a storage setting
   would be a poor trade for remembering a preference. */

const KEY = "erp.preview.maximized.v1";

function readStored() {
  try { return localStorage.getItem(KEY) === "1"; } catch { return false; }
}
function writeStored(v) {
  try { localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* not worth failing over */ }
}

export function usePreviewSize(onClose) {
  const [maximized, setMaximized] = useState(readStored);

  const toggle = useCallback(() => {
    setMaximized(v => { writeStored(!v); return !v; });
  }, []);

  useEffect(() => {
    function onKey(e) {
      /* Never while the user is typing — the Excel preview has a copy button
         and the PDF preview has controls, and stealing "f" from an input
         would be worse than not having a shortcut at all. */
      const tag = (e.target && e.target.tagName) || "";
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tag) || e.target?.isContentEditable) return;
      if (e.key === "Escape") { onClose?.(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "f" || k === "m") { e.preventDefault(); toggle(); }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, toggle]);

  return { maximized, toggle, boxClass: "pv-box" + (maximized ? " pv-max" : "") };
}

/* The button itself, so the two modals cannot drift on wording or icon. */
export function MaximizeButton({ maximized, onToggle }) {
  return (
    <button
      type="button"
      className="pv-max-btn"
      onClick={onToggle}
      title={maximized ? "Restore to reading width  (F)" : "Fill the screen  (F)"}
      aria-pressed={maximized}
      aria-label={maximized ? "Restore preview size" : "Maximise preview"}
    >
      <span aria-hidden="true">{maximized ? "⤡" : "⤢"}</span>
      {maximized ? "Restore" : "Maximise"}
    </button>
  );
}
