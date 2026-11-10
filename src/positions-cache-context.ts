import { createContext, useContext } from 'react';
import type { PositionsCache } from './positions-cache';

export const PositionsCacheContext = createContext<PositionsCache | null>(null);
export function usePositionsCache() {
  const cache = useContext(PositionsCacheContext);
  if (!cache) throw new Error('Positions cache provider is missing');
  return cache;
}
