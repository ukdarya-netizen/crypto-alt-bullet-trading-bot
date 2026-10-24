export async function processSourceCommand(inbox, mode, worker) {
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
  return inbox.complete(next.command.commandId, mode, outcome);
}
