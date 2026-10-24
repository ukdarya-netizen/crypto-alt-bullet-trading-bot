import { createHash } from "node:crypto";

export function validateSourceCommand(value, now = Date.now()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("command_object_required");
  }
  const allowed = new Set(["commandId", "sourceSignalId", "symbol", "type", "sequence",
    "occurredAt", "reason", "stopPrice", "scope"]);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new TypeError("unknown_command_field");
  for (const key of ["commandId", "sourceSignalId"]) {
    if (typeof value[key] !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(value[key])) {
      throw new TypeError(`invalid_${key}`);
    }
  }
  if (typeof value.symbol !== "string" || !/^[A-Z0-9]{1,20}USDT$/.test(value.symbol)) {
    throw new TypeError("invalid_symbol");
  }
  if (!["close", "move_stop", "cancel_entry"].includes(value.type)) throw new TypeError("invalid_type");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) throw new TypeError("invalid_sequence");
  const time = typeof value.occurredAt === "string" ? Date.parse(value.occurredAt) : NaN;
  if (!Number.isFinite(time) || time < 0 || time > now + 30_000) {
    throw new TypeError("invalid_occurredAt");
  }
  if (typeof value.reason !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(value.reason)) {
    throw new TypeError("invalid_reason");
  }
  if (value.type === "move_stop") {
    if (typeof value.stopPrice !== "string" || !/^\d+(?:\.\d+)?$/.test(value.stopPrice) ||
        !Number.isFinite(Number(value.stopPrice)) || Number(value.stopPrice) <= 0 ||
        value.scope !== undefined) throw new TypeError("invalid_stopPrice");
  } else if (value.stopPrice !== undefined || value.scope !== undefined && value.scope !== "all" ||
      value.type === "cancel_entry" && value.scope !== undefined) {
    throw new TypeError("unsupported_command_scope");
  }
  return { commandId: value.commandId, sourceSignalId: value.sourceSignalId,
    symbol: value.symbol, type: value.type, sequence: value.sequence,
    occurredAt: new Date(time).toISOString(), reason: value.reason,
    ...(value.type === "move_stop" ? { stopPrice: value.stopPrice } : {}),
    ...(value.type === "close" ? { scope: "all" } : {}) };
}

export function sourceCommandHash(command, now = Date.now()) {
  return createHash("sha256").update(JSON.stringify(validateSourceCommand(command, now))).digest("hex");
}

export function directCloseRequest(command, receivedAt) {
  return { requestId: `direct-command-${command.commandId}`,
    sourceSignalId: command.sourceSignalId, symbol: command.symbol,
    reason: "source_command_close", asOf: command.occurredAt, observedAt: receivedAt,
    evidence: { sourceSignalId: command.sourceSignalId, symbol: command.symbol,
      reason: "source_command_close", sourceAction: "close", sourceStatus: "command",
      sourceUpdatedAt: command.occurredAt, sourceClosedAt: null, sourceExitPrice: null,
      sourceCancelReason: null, exitDecisionAt: command.occurredAt,
      asOf: command.occurredAt, observedAt: receivedAt, command } };
}

export function directCloseEvidenceValid(evidence, sourceSignalId, symbol, requestId) {
  try {
    const command = validateSourceCommand(evidence?.command);
    return command.type === "close" && command.sourceSignalId === sourceSignalId &&
      command.symbol === symbol && requestId === `direct-command-${command.commandId}` &&
      evidence.reason === "source_command_close" && evidence.sourceAction === "close" &&
      evidence.sourceStatus === "command" && evidence.asOf === command.occurredAt &&
      evidence.sourceUpdatedAt === command.occurredAt &&
      evidence.exitDecisionAt === command.occurredAt &&
      evidence.sourceClosedAt === null && evidence.sourceExitPrice === null;
  } catch { return false; }
}
