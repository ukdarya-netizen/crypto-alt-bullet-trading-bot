export async function processSourceCommand(inbox, mode, worker, { onCompleted } = {}) {
  const next = await inbox.next(mode);
  if (!next) return null;
  let outcome;
  try {
    outcome = await worker.executeSourceCommand(next.command, {
      cancelEntry: inbox.cancelEntry,
      lookupPosition: inbox.lookupPosition,
      receivedAt: next.receivedAt,
    });
  } catch {
    // Never replay a native write on transport failure: the worker's durable
    // intent reconciliation must settle it before another command attempt.
    outcome = { status: "pending", reason: "command_execution_unavailable" };
  }
  const receipt = await inbox.complete(next.command.commandId, mode, outcome);
  onCompleted?.(outcome);
  return receipt;
}

// A confirmed command already did this pass's trading work. Do not insert a
// whole ordinary management sweep between queued commands. An uncertain
// command MUST still enter the tick so durable reconciliation can settle it.
export async function runSourceCommandOrTick(inbox, mode, worker) {
  let outcome;
  const receipt = await processSourceCommand(inbox, mode, worker, {
    onCompleted: value => { outcome = value; },
  });
  if (["executed", "rejected"].includes(outcome?.status)) return receipt;
  return worker.tick();
}
