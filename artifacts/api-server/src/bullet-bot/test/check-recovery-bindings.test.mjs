import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyRecoveryBindingDiagnostics } from "../../../check-recovery-bindings.mjs";

test("the recovery binding guard accepts a clean compiler exit", () => {
  assert.deepEqual(classifyRecoveryBindingDiagnostics({
    status: 0, signal: null, error: null, stdout: "", stderr: "",
  }), { ok: true, bindingDiagnostics: [] });
});

test("the recovery binding guard rejects missing-name TS2304 diagnostics", () => {
  const result = classifyRecoveryBindingDiagnostics({
    status: 2,
    stdout: "src/bullet-bot/vst-store.mjs(42,10): error TS2304: Cannot find name 'proof'.",
    stderr: "",
  });
  assert.equal(result.ok, false);
  assert.match(result.bindingDiagnostics[0], /error TS2304/);
});

test("the recovery binding guard rejects typo-suggestion TS2552 diagnostics", () => {
  const result = classifyRecoveryBindingDiagnostics({
    status: 2,
    stdout: "src/bullet-bot/vst-worker.mjs(42,10): error TS2552: Cannot find name 'postion'. Did you mean 'position'?",
    stderr: "",
  });
  assert.equal(result.ok, false);
  assert.match(result.bindingDiagnostics[0], /error TS2552/);
});

test("recognized non-binding diagnostics do not expand this guard into full typechecking", () => {
  assert.deepEqual(classifyRecoveryBindingDiagnostics({
    status: 2,
    stdout: "src/bullet-bot/vst-store.mjs(8,1): error TS2322: Type 'string' is not assignable to type 'number'.",
    stderr: "",
  }), { ok: true, bindingDiagnostics: [] });
});

test("a nonzero compiler exit without recognized TypeScript diagnostics fails closed", () => {
  const result = classifyRecoveryBindingDiagnostics({
    status: 2, stdout: "compiler crashed", stderr: "",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /without recognized TypeScript diagnostics/);
});

test("compiler spawn failures fail closed", () => {
  const result = classifyRecoveryBindingDiagnostics({
    status: null,
    signal: null,
    error: Object.assign(new Error("spawn pnpm ENOENT"), { code: "ENOENT" }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not complete \(ENOENT\)/);
});

test("compiler timeouts fail closed", () => {
  const result = classifyRecoveryBindingDiagnostics({
    status: null,
    signal: "SIGTERM",
    error: Object.assign(new Error("spawnSync pnpm ETIMEDOUT"), {
      code: "ETIMEDOUT",
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /could not complete \(ETIMEDOUT\)/);
});

test("compiler termination fails closed", () => {
  const result = classifyRecoveryBindingDiagnostics({
    status: null, signal: "SIGTERM", error: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /terminated by SIGTERM/);
});

test("malformed compiler exit statuses fail closed", () => {
  for (const status of [null, "0", -1, 256]) {
    const result = classifyRecoveryBindingDiagnostics({
      status, signal: null, error: null, stdout: "", stderr: "",
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /malformed exit status/);
  }
});