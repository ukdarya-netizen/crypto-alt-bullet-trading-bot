import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function assertSchemaPushOutputClean(output) {
  const errorLines = String(output).split(/\r?\n/).filter((line) => /\bERROR\b/i.test(line));
  if (errorLines.length > 0) {
    throw new Error(
      `Database schema push emitted ERROR output despite reporting success. ` +
        `Do not treat the schema as synchronized; investigate the reported DDL conflict. ` +
        `First error: ${errorLines[0].trim()}`,
    );
  }
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const outputPath = process.argv[2];
  if (!outputPath) {
    process.stderr.write("Usage: node scripts/check-schema-push-output.mjs <captured-push-output>\n");
    process.exitCode = 2;
  } else {
    try {
      assertSchemaPushOutputClean(await readFile(outputPath, "utf8"));
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}