interface SettingsLoadOptions<T> {
  signal: AbortSignal;
  load: (signal: AbortSignal) => Promise<T>;
  isCurrent: () => boolean;
  onData: (value: T) => void;
  onError: (timedOut: boolean) => void;
}

export async function loadSettings<T>({ signal, load, isCurrent, onData, onError }: SettingsLoadOptions<T>): Promise<void> {
  try {
    const next = await load(signal);
    if (!signal.aborted && isCurrent()) onData(next);
  } catch {
    const timedOut = signal.aborted && signal.reason?.name === "TimeoutError";
    if (isCurrent() && (!signal.aborted || timedOut)) onError(timedOut);
  }
}
