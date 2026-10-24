import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API_ROOT = fileURLToPath(new URL(".", import.meta.url));
const COMPILER_TIMEOUT_MS = 60_000;
const COMPILER_MAX_BUFFER = 16 * 1024 * 1024;
const TARGETS = [
  "src/bullet-bot/bingx-live-api.mjs",
  "src/bullet-bot/vst-broker.mjs",
  "src/bullet-bot/vst-worker.mjs",
  "src/bullet-bot/vst-store.mjs",
];
const BINDING_CODES = new Set(["2304", "2552"]);

function compilerOutput(result) {
  return [result?.stdout, result?.stderr]
    .filter((part) => typeof part === "string")
    .join("\n");
}

export function classifyRecoveryBindingDiagnostics(result) {
  if (result?.error) {
    const code = result.error.code ? ` (${result.error.code})` : "";
    return {
      ok: false,
      reason: `TypeScript compiler could not complete${code}: ${
        result.error.message ?? String(result.error)
      }`,
      bindingDiagnostics: [],
    };
  }
  if (result?.signal) {
    return {
      ok: false,
      reason: `TypeScript compiler was terminated by ${result.signal}`,
      bindingDiagnostics: [],
    };
  }
  if (!Number.isInteger(result?.status) ||
      result.status < 0 || result.status > 255) {
    return {
      ok: false,
      reason: `TypeScript compiler returned a malformed exit status: ${
        String(result?.status)
      }`,
      bindingDiagnostics: [],
    };
  }

  const output = compilerOutput(result);
  const diagnosticCodes = [...output.matchAll(/\berror TS(\d{4}):/g)]
    .map((match) => match[1]);
  const bindingDiagnostics = output.split(/\r?\n/)
    .filter((line) => /\berror TS(?:2304|2552):/.test(line));
  if (bindingDiagnostics.length > 0) {
    return {
      ok: false,
      reason: "TypeScript reported an unbound name in a recovery target",
      bindingDiagnostics,
    };
  }
  if (result.status !== 0 && diagnosticCodes.length === 0) {
    return {
      ok: false,
      reason: `TypeScript compiler exited with status ${result.status} without recognized TypeScript diagnostics`,
      bindingDiagnostics: [],
    };
  }
  return { ok: true, bindingDiagnostics: [] };
}

export function runRecoveryBindingCheck() {
  const result = spawnSync("pnpm", [
    "exec", "tsc",
    "--allowJs",
    "--checkJs",
    "--noEmit",
    "--skipLibCheck",
    "--module", "nodenext",
    "--target", "es2022",
    "--moduleResolution", "nodenext",
    ...TARGETS,
  ], {
    cwd: API_ROOT,
    encoding: "utf8",
    timeout: COMPILER_TIMEOUT_MS,
    maxBuffer: COMPILER_MAX_BUFFER,
  });
  const classification = classifyRecoveryBindingDiagnostics(result);
  if (!classification.ok) {
    console.error(`Recovery binding guard failed: ${classification.reason}`);
    for (const diagnostic of classification.bindingDiagnostics) {
      console.error(diagnostic);
    }
    return false;
  }
  console.log("Recovery binding guard passed: no TS2304 or TS2552 diagnostics.");
  return true;
}

if (process.argv[1] &&
    fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (!runRecoveryBindingCheck()) process.exitCode = 1;
}