'use client';

import { useEffect, useState } from 'react';
import { fetchPairSymbols, type PairSymbol } from './pair-symbols';

const EMPTY_SYMBOLS: readonly PairSymbol[] = [];

export function usePairSymbols(active: boolean) {
  const [request, setRequest] = useState({ active, revision: 0 });
  if (request.active !== active)
    setRequest({ active, revision: request.revision + 1 });
  const revision = request.revision;
  const [state, setState] = useState<{
    revision: number;
    symbols: readonly PairSymbol[];
    error: string;
  }>({ revision: -1, symbols: EMPTY_SYMBOLS, error: '' });

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => controller.abort(), 10000);
    void fetchPairSymbols(controller.signal)
      .then((symbols) => {
        if (!disposed) setState({ revision, symbols, error: '' });
      })
      .catch((cause: unknown) => {
        if (!disposed)
          setState({
            revision,
            symbols: EMPTY_SYMBOLS,
            error: controller.signal.aborted
              ? '配对标的目录读取超时，请重试'
              : cause instanceof Error
                ? cause.message
                : '配对标的目录读取失败，请重试',
          });
      })
      .finally(() => clearTimeout(timeout));
    return () => {
      disposed = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [active, revision]);

  const current = active && state.revision === revision;
  return {
    loading: active && !current,
    symbols: current ? state.symbols : EMPTY_SYMBOLS,
    error: current ? state.error : '',
    retry: () =>
      setRequest((previous) => ({
        ...previous,
        revision: previous.revision + 1,
      })),
  };
}
