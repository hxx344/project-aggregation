import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/** False while hydrating server HTML, true afterwards and on renders that did not start from server HTML. */
export function useHydrated() {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
