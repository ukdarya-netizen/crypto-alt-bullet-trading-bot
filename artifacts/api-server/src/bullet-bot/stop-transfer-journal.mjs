export const STOP_TRANSFER_PROTOCOL = 1;
const operations = new Set([
  "raise_stop", "split_raise_stop_place", "split_raise_stop_cancel",
  "retire_adopted_stop",
]);
export const isStopTransferOperation = (operation) => operations.has(operation);

export function matchesPreparedStopTransferPosition(request, snapshot) {
  const prior = request?.priorPosition;
  if (!prior || !snapshot) return false;
  const identity = [
    "sourceSignalId", "symbol", "environment", "accountId", "exchangePositionId",
    "entryOrderId", "entryClientOrderId", "entryPrice", "initialQty", "remainingQty",
    "coreQty", "runnerQty", "coreOpen", "runnerOpen",
  ];
  if (!identity.every(key => prior[key] === snapshot[key])) return false;
  const stops = position => Object.entries(position.verifiedProtectiveStops ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([leg, stop]) => [leg, stop?.orderId, stop?.positionId, stop?.quantity, stop?.stopPrice]);
  const canonical = value => value && typeof value === "object"
    ? Array.isArray(value) ? value.map(canonical)
      : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    : value;
  return JSON.stringify(stops(prior)) === JSON.stringify(stops(snapshot)) &&
    JSON.stringify(canonical(prior.manualResolution)) ===
      JSON.stringify(canonical(snapshot.manualResolution));
}

const identifier = (value) => {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new Error("stop_transfer_exact_order_id_required");
  }
  return value;
};

// Progress is durable before transport, not inferred from an unchanged account.
// The persister must compare-and-set the previous stage and immutable request.
export function createStopTransferJournal({ request, progress, persist }) {
  if (request.stopTransferProtocol !== STOP_TRANSFER_PROTOCOL ||
      !isStopTransferOperation(request.operation) || typeof persist !== "function") {
    throw new Error("stop_transfer_protocol_unavailable");
  }
  let current = progress ?? { version: STOP_TRANSFER_PROTOCOL, stage: "prepared" };
  if (current.version !== STOP_TRANSFER_PROTOCOL) {
    throw new Error("stop_transfer_progress_version_invalid");
  }
  const advance = async (stage, detail = {}, exchangeOrderId = null) => {
    const next = { ...current, ...detail, stage };
    if (!await persist(current.stage, next, exchangeOrderId)) {
      throw new Error("stop_transfer_progress_persistence_failed");
    }
    current = next;
  };
  const cancellationOnly = ["split_raise_stop_cancel", "retire_adopted_stop"]
    .includes(request.operation);
  return {
    getProgress: () => ({ ...current }),
    async beforeMutation({ method, params }) {
      if (params.symbol !== request.symbol.replace(/USDT$/, "-USDT")) {
        throw new Error("stop_transfer_mutation_symbol_conflict");
      }
      if (method === "POST" && !cancellationOnly &&
          current.stage === "prepared" && params.type === "STOP_MARKET") {
        await advance("post_started", {
          stopPrice: String(params.stopPrice), quantity: String(params.quantity),
        });
      } else if (method === "DELETE" &&
          (cancellationOnly ? current.stage === "prepared"
            : request.operation === "raise_stop" &&
              current.stage === "post_acknowledged" &&
              typeof current.newStopOrderId === "string")) {
        await advance("cancel_started", { oldStopOrderId: identifier(params.orderId) });
      } else {
        throw new Error("stop_transfer_mutation_replay_forbidden");
      }
    },
    async acknowledge(orderId) {
      const id = identifier(orderId);
      if (["post_acknowledged", "cancel_started", "cancel_acknowledged"].includes(current.stage) &&
          current.newStopOrderId === id) return;
      if (current.stage !== "post_started") {
        throw new Error("stop_transfer_acknowledgement_conflict");
      }
      await advance("post_acknowledged", { newStopOrderId: id }, id);
    },
    async mutationNotSent({ method }) {
      if (method === "POST" && current.stage === "post_started") {
        await advance("prepared", { lastNoSendMethod: method });
      } else if (method === "DELETE" && current.stage === "cancel_started") {
        await advance(cancellationOnly ? "prepared" : "post_acknowledged", {
          lastNoSendMethod: method,
        });
      } else {
        throw new Error("stop_transfer_no_send_stage_conflict");
      }
    },
    async afterMutation({ method, orderId }) {
      if (method === "POST") {
        if (orderId !== undefined) await this.acknowledge(orderId);
      } else if (method === "DELETE" && current.stage === "cancel_started") {
        await advance("cancel_acknowledged");
      } else {
        throw new Error("stop_transfer_response_stage_conflict");
      }
    },
  };
}