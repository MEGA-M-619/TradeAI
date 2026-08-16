import { useSyncExternalStore } from "react";

function subscribe() {
  return () => {};
}

/**
 * True only after the client has hydrated. Used to defer portal-based
 * UI (toasts, dialogs) until after hydration, since rendering into
 * document.body during the hydration pass itself can corrupt React's
 * reconciliation of <body>'s own children. useSyncExternalStore (rather
 * than a useState+useEffect pair) keeps this a read of external state
 * instead of a setState-in-effect.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
