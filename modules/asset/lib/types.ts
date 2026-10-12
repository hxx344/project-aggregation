export type Balance = { coin: string; account: string; quantity: number; value: number; price: number };
export type Asset = { id: string; project: string; kind: string; quantity: number | null; price: number | null; value: number | null; cell: string; mode: 'manual' | 'market' | 'bybit' | 'aster' | 'binance' | 'okx' | 'variational'; updatedAt: string; status: string; error?: string; details?: Balance[] };
export type FxStatus = { source: 'Coinbase' | 'Frankfurter' | 'manual' | 'saved'; fetchedAt: string | null; rateDate: string | null; error: string | null };
export type Period = { id: string; date: string; total: number; fx: number; cny: number; future: boolean; difference: number; partial?: boolean; archived?: boolean; withdrawn?: number; fxStatus?: FxStatus };
export type Withdrawal = { id: string; date: string; amount: number; note: string; createdAt: string; updatedAt: string };
export type Connection = { configured: boolean; lastSync: string | null; error: string | null; scope: string; label?: string };
export type AsterAccount = Connection & { id: string; name: string; value: number; details: Balance[]; updatedAt: string; includeSpot: boolean; walletAddress?: string };
export type Ledger = { dataKind: 'example' | 'personal'; assets: Asset[]; history: Period[]; withdrawals: Withdrawal[]; asterAccounts: AsterAccount[]; fx: number; fxStatus: FxStatus; baselineDate: string; startedAt: string; baselineTotal: number; connections: { bybit: Connection; aster: Connection; binance: Connection; okx: Connection; variational: Connection } };
