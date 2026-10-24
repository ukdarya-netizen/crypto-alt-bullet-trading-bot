import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Orval 8.30 sometimes leaves extra blank lines at EOF in these split outputs.
// Keep the checked-in files stable after the regression command regenerates them.
for (const file of [
  "../api-client-react/src/generated/api.schemas.ts",
  "../api-zod/src/generated/api.ts",
]) {
  const target = path.resolve(import.meta.dirname, file);
  const content = await readFile(target, "utf8");
  await writeFile(target, `${content.trimEnd()}\n`);
}