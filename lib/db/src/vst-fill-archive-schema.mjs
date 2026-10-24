export const VST_FILL_ARCHIVE_REQUIRED_COLUMNS = Object.freeze({
  vst_fill_archive_windows: Object.freeze([
    "id", "environment", "account_id", "currency", "start_ts", "end_ts",
    "window_hash", "archive_window", "observed_at", "invalidated_at",
    "invalidation_reason",
  ]),
  vst_fill_archive_fills: Object.freeze([
    "environment", "account_id", "currency", "symbol", "trade_id", "raw_fill",
  ]),
});

const READINESS_SQL = `
  SELECT required.table_name,
         resolved.schema_name,
         resolved.relkind,
         available.schemas AS existing_schemas,
         array_agg(attribute.attname::text)
           FILTER (WHERE attribute.attname IS NOT NULL) AS columns
  FROM unnest($1::text[]) AS required(table_name)
  LEFT JOIN LATERAL (
    SELECT relation.oid, namespace.nspname AS schema_name, relation.relkind
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE relation.oid = pg_catalog.to_regclass(required.table_name)
  ) AS resolved ON true
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = resolved.oid
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  LEFT JOIN LATERAL (
    SELECT array_agg(DISTINCT namespace.nspname::text ORDER BY namespace.nspname::text) AS schemas
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
    WHERE relation.relname = required.table_name
      AND relation.relkind IN ('r', 'p')
      AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
  ) AS available ON true
  GROUP BY required.table_name, resolved.schema_name, resolved.relkind, available.schemas
`;

/**
 * Read-only check of the exact unqualified relations the archive store uses.
 * Also distinguishes an absent table from a table hidden outside search_path.
 */
export async function inspectVstFillArchiveSchema(database) {
  if (!database || typeof database.query !== "function") {
    throw new TypeError("inspectVstFillArchiveSchema requires a query-capable database");
  }

  const result = await database.query(
    READINESS_SQL,
    [Object.keys(VST_FILL_ARCHIVE_REQUIRED_COLUMNS)],
  );
  const byName = new Map(result.rows.map((row) => [row.table_name, row]));
  const missing = [];

  for (const [tableName, requiredColumns] of Object.entries(VST_FILL_ARCHIVE_REQUIRED_COLUMNS)) {
    const row = byName.get(tableName);
    if (!row?.schema_name) {
      const schemas = Array.isArray(row?.existing_schemas) ? row.existing_schemas : [];
      missing.push(schemas.length
        ? `${tableName} (exists in schema(s) ${schemas.join(", ")} outside search_path)`
        : tableName);
      continue;
    }
    if (row.relkind !== "r" && row.relkind !== "p") {
      missing.push(`${tableName} (resolved to a non-table relation in schema ${row.schema_name})`);
      continue;
    }
    const actualColumns = new Set(Array.isArray(row.columns) ? row.columns : []);
    for (const column of requiredColumns) {
      if (!actualColumns.has(column)) missing.push(`${tableName}.${column}`);
    }
  }

  return { ready: missing.length === 0, missing };
}