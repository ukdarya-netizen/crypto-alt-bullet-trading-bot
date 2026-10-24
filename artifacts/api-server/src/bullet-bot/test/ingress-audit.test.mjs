import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createIngressAuditEvent,
  validatedIngressSourceSignalId,
} from "../ingress-audit.mjs";

test("ingress audit exposes only bounded source ids and reviewed rejection details", () => {
  assert.equal(validatedIngressSourceSignalId("cab-signal-123"), "cab-signal-123");
  assert.equal(validatedIngressSourceSignalId("cab-signal-0"), undefined);
  assert.equal(validatedIngressSourceSignalId(`cab-signal-${"1".repeat(19)}`), undefined);

  const event = createIngressAuditEvent({
    mode: "both",
    status: 422,
    outcome: "rejected",
    sourceSignalId: "cab-signal-123",
    rejectionCode: "expired_or_future_signal",
    rejectionField: "signalAt",
    body: { secret: "must not pass" },
    headers: { authorization: "must not pass" },
    providerMessage: "must not pass",
  });
  assert.deepEqual(event, {
    type: "bot_signal_ingress",
    mode: "both",
    status: 422,
    outcome: "rejected",
    sourceSignalId: "cab-signal-123",
    rejection: { code: "expired_or_future_signal", field: "signalAt" },
  });
});

test("unreviewed rejection fields and malformed ids are omitted", () => {
  const event = createIngressAuditEvent({
    mode: "paper",
    status: 400,
    outcome: "rejected",
    sourceSignalId: "cab-signal-123\nsecret",
    rejectionCode: "invalid_number",
    rejectionField: "provider.error",
    stores: { vst: "received", paper: "secret", unknown: "failed" },
  });
  assert.deepEqual(event, {
    type: "bot_signal_ingress",
    mode: "paper",
    status: 400,
    outcome: "rejected",
    stores: { vst: "received" },
  });
});