export type HubQuery = {
  symbol?: string;
  longExchange?: string;
  shortExchange?: string;
  longContract?: string;
  shortContract?: string;
  opportunityKind?: 'spread' | 'funding';
  importId?: string;
};
export const HUB_QUERY_KEYS: readonly (keyof HubQuery)[];
export function cleanHubQuery(input: unknown): HubQuery | null;
