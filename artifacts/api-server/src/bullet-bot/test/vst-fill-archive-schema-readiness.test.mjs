import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  inspectVstFillArchiveSchema,
  VST_FILL_ARCHIVE_REQUIRED_COLUMNS,
} from "../../../../../lib/db/src/vst-fill-archive-schema.mjs";
import { assertSchemaPushOutputClean } from "../../../../../scripts/check-schema-push-output.mjs";

const workspaceRoot = new URL("../../../../../", import.meta.url);

async function readWorkspaceFile(path) {
  return readFile(new URL(path, workspaceRoot), "utf8");
}

function completeRows() {
  return Object.entries(VST_FILL_ARCHIVE_REQUIRED_COLUMNS).map(([table_name, columns]) => ({
    table_name,
    schema_name: "public",
    relkind: "r",
    existing_schemas: ["public"],
    columns: [...columns],
  }));
}

test("post-merge targets the real db package and verifies schema after its push", async () => {
  const [postMerge, packageJson] = await Promise.all([
    readWorkspaceFile("scripts/post-merge.sh"),
    readWorkspaceFile("lib/db/package.json"),
  ]);
  const dbPackage = JSON.parse(packageJson);
  assert.equal(dbPackage.name, "@workspace/db");
  assert.equal(
    dbPackage.scripts["verify-vst-fill-archive-schema"],
    "node ./scripts/verify-vst-fill-archive-schema.mjs",
  );
  assert.match(postMerge, /pnpm --filter @workspace\/db --fail-if-no-match run push-force/);
  assert.match(postMerge, /2>&1 \| tee "\$push_output"/);
  assert.match(postMerge, /check-schema-push-output\.mjs "\$push_output"/);
  assert.match(postMerge, /pnpm --filter @workspace\/db --fail-if-no-match run verify-vst-fill-archive-schema/);
  assert.doesNotMatch(postMerge, /--filter\s+db(?:\s|$)/);
  assert.ok(
    postMerge.indexOf("run verify-vst-fill-archive-schema") >
      postMerge.indexOf("run push-force"),
    "the read-only verification must run after schema push",
  );
  assert.ok(
    postMerge.indexOf("check-schema-push-output.mjs") <
      postMerge.indexOf("run verify-vst-fill-archive-schema"),
    "the push output guard must reject false success before metadata verification",
  );
});

test("catalog name-array aggregates use text arrays understood by node-postgres", async () => {
  let query;
  const result = await inspectVstFillArchiveSchema({
    async query(sql) {
      query = sql;
      return { rows: completeRows() };
    },
  });
  assert.equal(result.ready, true);
  // pg_catalog.name[] is returned as a raw string by the default pg parser.
  // Native pg reads must agree with the structured fixtures.
  assert.match(query, /array_agg\(attribute\.attname::text\)/);
  assert.match(query, /array_agg\(DISTINCT namespace\.nspname::text/);
});

test("schema push output guard rejects Drizzle ERROR text even after process success", () => {
  assert.doesNotThrow(() => assertSchemaPushOutputClean("No schema changes detected."));
  assert.throws(
    () => assertSchemaPushOutputClean(
      "drizzle-kit push complete\nERROR: relation btb_live_order_intents_client_id_uk already exists",
    ),
    /Do not treat the schema as synchronized.*investigate the reported DDL conflict/,
  );
});

test("read-only preflight accepts exact resolved public tables and required columns", async () => {
  const queries = [];
  const readiness = await inspectVstFillArchiveSchema({
    async query(sql, values) {
      queries.push({ sql, values });
      return { rows: completeRows() };
    },
  });
  assert.deepEqual(readiness, { ready: true, missing: [] });
  assert.deepEqual(queries[0].values, [
    Object.keys(VST_FILL_ARCHIVE_REQUIRED_COLUMNS),
  ]);
  assert.match(queries[0].sql, /to_regclass/);
  assert.match(queries[0].sql, /existing_schemas/);
  assert.doesNotMatch(queries[0].sql, /\b(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE)\b/i);
});

test("read-only preflight reports tables outside search_path and absent required columns", async () => {
  const rows = completeRows();
  rows[0] = {
    ...rows[0],
    schema_name: null,
    columns: null,
    existing_schemas: ["archive"],
  };
  rows[1] = {
    ...rows[1],
    columns: rows[1].columns.filter((column) => column !== "raw_fill"),
  };
  const readiness = await inspectVstFillArchiveSchema({
    async query() { return { rows }; },
  });
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.missing, [
    "vst_fill_archive_windows (exists in schema(s) archive outside search_path)",
    "vst_fill_archive_fills.raw_fill",
  ]);
});

test("read-only preflight propagates database errors instead of reporting false readiness", async () => {
  const databaseError = Object.assign(new Error("metadata query failed"), { code: "08006" });
  await assert.rejects(
    inspectVstFillArchiveSchema({ async query() { throw databaseError; } }),
    (error) => error === databaseError,
  );
});