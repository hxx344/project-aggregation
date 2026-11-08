export type BinanceCredentials = { apiKey: string; apiSecret: string };
/** timestamp and recvWindow are decimal digit strings (milliseconds). */
export function binanceSignedQuery(
  credentials: BinanceCredentials,
  parameters: ConstructorParameters<typeof URLSearchParams>[0],
  options: { timestamp: string; recvWindow: string },
): { query: string; headers: { 'X-MBX-APIKEY': string } };
