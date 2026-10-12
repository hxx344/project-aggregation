import { lazy, Suspense, useSyncExternalStore, type ComponentType, type ReactNode } from "react";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

function ClientOnly({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  // Hydration uses the server snapshot before switching to the client snapshot.
  const hydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  return hydrated ? children : fallback;
}

export function lazyComponent<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
  { loading, clientOnly = false }: { loading: () => ReactNode; clientOnly?: boolean },
) {
  const Component = lazy(load);
  return function LazyComponent(props: Props) {
    const fallback = loading();
    const content = <Suspense fallback={fallback}><Component {...props}/></Suspense>;
    return clientOnly ? <ClientOnly fallback={fallback}>{content}</ClientOnly> : content;
  };
}
