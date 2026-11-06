import { useRef, useState } from 'react';

/** Desktop and mobile session menus use the same pending-state and duplicate-click guard. */
export function useForkAction(action?: () => void | Promise<void>) {
  // Keeps the menu's loading indicator visible until branch creation finishes.
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const run = async () => {
    if (!action || busy.current) return;
    busy.current = true; setPending(true);
    try { await action(); } finally { busy.current = false; setPending(false); }
  };
  return { pending, run };
}
