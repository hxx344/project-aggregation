export function canonicalBase(exchange: string, nativeBase: string): string;
export function crossexBase(exchange: string, nativeBase: string): string;
export function validBaseMapping(exchange: string, base: string, rawBase?: string): boolean;
export function isBaseBlocked(blocked: ReadonlySet<string>, base: string): boolean;
