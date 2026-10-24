export const VST_FILL_ARCHIVE_REQUIRED_COLUMNS: Readonly<
  Record<string, readonly string[]>
>;

export function inspectVstFillArchiveSchema(database: {
  query: (sql: string, values?: unknown[]) => Promise<{
    rows: Array<{
      table_name: string;
      schema_name: string | null;
      relkind: string | null;
      existing_schemas: string[] | null;
      columns: string[] | null;
    }>;
  }>;
}): Promise<{ ready: boolean; missing: string[] }>;