import assert from "node:assert/strict";
import { test } from "node:test";
import { createSourceFreshnessWatchdog } from "../source-lifecycle-scheduler.mjs";
import { createHealthIncidentStore, validateHealthCheckpoint } from "../health-incident-store.mjs";

const flush = async () => new Promise((resolve) => setImmediate(resolve));
function harness(options = {}) {
  const clock = { value: 0 };
  const sent = [];
  let durable = null;
  let failures = 0;
  const errors = [];
  const persistence = {
    async load() { return structuredClone(durable); },
    async save(state) { durable = structuredClone(validateHealthCheckpoint(state)); },
  };
  const make = () => {
    const w = createSourceFreshnessWatchdog({
      now: () => clock.value, persistence,
      sendAlert: async (event) => {
        sent.push(event);
        if (failures > 0) { failures--; throw new Error("Telegram unavailable"); }
      },
      onError: (error) => errors.push(error),
      setIntervalFn: () => 1, clearIntervalFn() {},
      ...options,
    });
    w.start();
    return w;
  };
  return {
    clock, sent, make, persistence, errors,
    fail: (n) => { failures = n; },
    durable: () => structuredClone(durable),
    warning: async (w) => {
      clock.value = 180_000;
      w.failed(); w.failed(); w.failed();
      await flush(); await w.flushPersistence();
    },
  };
}

test("delivered warning survives restart with its full 30-minute cooldown", async () => {
  const h = harness({ criticalAfterMs: 10_000_000 });
  let w = h.make(); await flush();
  await h.warning(w);
  assert.equal(h.durable().incident.deliveredSeverity, "warning");
  w.stop();
  h.clock.value = 190_000;
  w = h.make(); await flush();
  w.check(); await flush();
  assert.equal(h.sent.length, 1);
  h.clock.value = 1_979_999; w.check(); await flush();
  assert.equal(h.sent.length, 1);
  h.clock.value = 1_980_000; w.check(); await flush();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].severity, "warning");
  w.stop();
});

test("restart preserves warning-to-critical escalation, critical delivery and cooldown", async () => {
  const h = harness();
  let w = h.make(); await flush(); await h.warning(w); w.stop();
  h.clock.value = 299_999; w = h.make(); await flush();
  w.check(); await flush();
  assert.equal(h.sent.length, 1);
  h.clock.value = 300_000; w.check(); await flush();
  assert.deepEqual(h.sent.map((e) => e.severity), ["warning", "critical"]);
  w.stop();
  h.clock.value = 310_000; w = h.make(); await flush();
  w.check(); await flush();
  assert.equal(h.sent.length, 2);
  h.clock.value = 2_099_999; w.check(); await flush();
  assert.equal(h.sent.length, 2);
  h.clock.value++; w.check(); await flush();
  assert.equal(h.sent.length, 3);
  w.stop();
});

test("undelivered warning survives restart but stable recovery silently clears it", async () => {
  const h = harness(); h.fail(1);
  let w = h.make(); await flush(); await h.warning(w);
  assert.equal(h.durable().incident.alertedAt, null);
  assert.equal(h.durable().incident.nextAlertAt, 240_000);
  w.stop();
  h.clock.value = 185_000; w = h.make(); await flush();
  w.healthy(h.clock.value);
  h.clock.value = 215_000; w.healthy(h.clock.value); await flush();
  assert.equal(w.getIncident(), null);
  assert.equal(h.durable().incident, null);
  w.stop();
  h.clock.value = 240_000; w = h.make(); await flush();
  w.check(); await flush();
  assert.equal(h.sent.length, 1, "neither stale retry nor orphan recovery");
  w.stop();
});

test("restart during recovery discards prior stability and needs new fresh admissions", async () => {
  const h = harness();
  let w = h.make(); await flush(); await h.warning(w);
  h.clock.value = 185_000; w.healthy(h.clock.value); await flush();
  assert.notEqual(w.getIncident().recoverySince, null);
  assert.equal("recoverySince" in h.durable().incident, false);
  w.stop();
  h.clock.value = 200_000; w = h.make(); await flush();
  assert.equal(w.getIncident().recoverySince, null);
  h.clock.value = 215_000; w.check(); await flush();
  assert.equal(h.sent.length, 1);
  w.healthy(h.clock.value);
  h.clock.value = 244_999; w.healthy(h.clock.value); await flush();
  assert.equal(h.sent.length, 1);
  h.clock.value = 245_000; w.healthy(h.clock.value); await flush();
  assert.deepEqual(h.sent.map((e) => e.kind), ["stale", "recovered"]);
  assert.equal(h.durable().incident, null);
  w.stop();
});

test("failed deliveries stay rate-bounded across repeated restarts; escalation bypasses old retry", async () => {
  const h = harness(); h.fail(10);
  let w = h.make(); await flush(); await h.warning(w); w.stop();
  h.clock.value = 239_999; w = h.make(); await flush();
  w.check(); await flush(); assert.equal(h.sent.length, 1);
  h.clock.value++; w.check(); await flush(); assert.equal(h.sent.length, 2);
  w.stop();
  h.clock.value = 299_999; w = h.make(); await flush();
  w.check(); await flush(); assert.equal(h.sent.length, 2);
  h.clock.value++; w.check(); await flush(); assert.equal(h.sent.length, 3);
  assert.equal(h.sent[2].severity, "critical");
  w.stop();
  h.clock.value = 300_001; w = h.make(); await flush();
  w.check(); await flush(); assert.equal(h.sent.length, 3);
  w.stop();
});

test("unavailable checkpoint never means a new healthy process or an empty incident", async () => {
  const h = harness();
  const load = h.persistence.load;
  let loads = 0;
  h.persistence.load = async () => { loads++; throw new Error("checkpoint unavailable"); };
  const w = h.make(); await flush();
  h.clock.value = 300_000; w.check(); await flush();
  w.healthy(h.clock.value);
  assert.equal(w.getState().lastHealthyAt, null);
  assert.equal(h.sent.length, 0);
  h.clock.value = 359_999; w.check(); await flush(); assert.equal(loads, 2);
  h.persistence.load = load;
  h.clock.value = 360_000; w.check(); await flush();
  w.check(); await flush();
  assert.equal(h.sent[0].severity, "critical");
  w.stop();
});

test("persistence failure before transport refuses health delivery, not an acknowledgement", async () => {
  const h = harness();
  const save = h.persistence.save;
  const w = h.make(); await flush();
  h.persistence.save = async () => { throw new Error("write unavailable"); };
  await h.warning(w).catch(() => {});
  assert.equal(h.sent.length, 0);
  assert.equal(w.getIncident().alertedAt, null);
  h.persistence.save = save;
  h.clock.value = 239_999; w.check(); await flush(); assert.equal(h.sent.length, 0);
  h.clock.value++; w.check(); await flush(); assert.equal(h.sent.length, 1);
  w.stop();
});

test("stale or replayed snapshots cannot qualify recovery", async () => {
  const h = harness();
  const w = h.make(); await flush(); await h.warning(w);
  h.clock.value = 185_000; w.healthy(185_000);
  h.clock.value = 215_000; w.healthy(185_000); await flush();
  assert.equal(h.sent.length, 1);
  h.clock.value = 220_000; w.healthy(0); await flush();
  assert.equal(w.getIncident().recoverySince, null);
  w.stop();
});

test("store uses only its fixed health key and parameterized upsert; invalid state fails closed", async () => {
  const calls = [];
  const state = { version: 1, incident: null };
  const store = createHealthIncidentStore({ async query(config) {
    calls.push({ sql: config.text, params: config.values });
    assert.equal(config.query_timeout, 5_000);
    return { rows: calls.length === 1 ? [{ state }] : [] };
  } });
  assert.deepEqual(await store.load(), state);
  await store.save(state);
  assert.deepEqual(calls[0].params, ["source-freshness"]);
  assert.deepEqual(calls[1].params, ["source-freshness", JSON.stringify(state)]);
  assert.match(calls[1].sql, /ON CONFLICT/);
  await assert.rejects(store.save({ version: 9 }), /version/);
  assert.throws(() => validateHealthCheckpoint({ version: 1, incident: {} }));
  const broken = createHealthIncidentStore({ async query() {
    return { rows: [{ state: { version: 1, incident: {} } }] };
  } });
  await assert.rejects(broken.load(), /checkpoint/);
});

test("acknowledgement write failure cannot resend a delivered page in the same process", async () => {
  const h = harness();
  const save = h.persistence.save;
  let rejectAcknowledgement = true;
  h.persistence.save = async (state) => {
    if (rejectAcknowledgement && state.incident?.alertedAt !== null &&
        state.incident?.alertedAt !== undefined) throw new Error("ack save failed");
    await save(state);
  };
  const w = h.make(); await flush(); await h.warning(w).catch(() => {});
  assert.equal(h.sent.length, 1);
  assert.notEqual(w.getIncident().alertedAt, null, "keep Telegram's actual acknowledgement in memory");
  rejectAcknowledgement = false;
  h.clock.value = 185_000; w.check(); await flush();
  assert.equal(h.sent.length, 1);
  assert.equal(h.durable().incident.alertedAt, 180_000);
  w.stop();
});

test("a delayed save stays ordered ahead of escalation acknowledgement", async () => {
  const h = harness();
  const save = h.persistence.save;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let gated = false;
  h.persistence.save = async (state) => {
    if (!gated && state.incident?.severity === "warning") {
      gated = true;
      await gate;
    }
    await save(state);
  };
  const w = h.make(); await flush();
  h.clock.value = 180_000; w.failed(); w.failed(); w.failed(); await flush();
  assert.equal(h.sent.length, 0, "transport waits for its persisted attempt");
  h.clock.value = 300_000; w.check();
  release(); await flush();
  w.check(); await flush();
  assert.deepEqual(h.sent.map((e) => e.severity), ["warning", "critical"]);
  assert.equal(h.durable().incident.deliveredSeverity, "critical");
  w.stop();
});