// The HTTP boundary validates the complete projection with generated Zod schemas.
type Row = Record<string, unknown>;
type Pool = { query(sql: string, params: unknown[]): Promise<{ rows: Row[] }> };
export function readVstEntryLatency(pool: Pool, options?: { now?: () => number }): Promise<unknown>;
export function buildVstEntryLatency(
  rows: Row[], options: { asOf: string; since: string; total?: number },
): unknown;
