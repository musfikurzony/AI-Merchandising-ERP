import React from "react";
import { useStickyScope } from "../lib/viewState.js";

/* "This is how you left it."

   A screen that silently comes back filtered is a trap. The merchandiser who
   set a factory filter before lunch sees a third of the order book on return,
   and the reasonable conclusion is that data has gone missing — not that a
   filter they no longer remember is still applied. So a restored screen says
   so, once, and offers one click to clear it.

   It appears ONLY when something was actually restored AND that something
   differs from the defaults, and it disappears the moment the user touches
   any control on that screen — at which point the view is theirs again and
   the notice would be describing history rather than the present.

   Deliberately a thin inline line rather than a banner: it is a reassurance,
   not a warning, and a yellow box across the top of every screen you return
   to would be its own kind of noise. */
export default function RestoredNotice({ scope, label = "filters" }) {
  const { restored, reset } = useStickyScope(scope);
  if (!restored) return null;
  return (
    <div className="rs-note" role="status">
      <span className="rs-dot" aria-hidden="true">↺</span>
      <span>Showing where you left off — your {label} are still applied.</span>
      <button className="rs-reset" onClick={reset}>Reset to default</button>
    </div>
  );
}
