export const SOURCE_CLOSE_STATUSES = new Set([
  "profit", "stop_loss", "bu_stop", "breakeven", "expired",
]);
export const SOURCE_ACTIONS = new Set(["hold", "close", "review", "unknown"]);

export function validateSourceAction(source) {
  if (!SOURCE_ACTIONS.has(source?.sourceAction)) return false;
  if (source.sourceAction === "close") return SOURCE_CLOSE_STATUSES.has(source.sourceStatus) &&
    typeof source.sourceClosedAt === "string" && Number.isFinite(Date.parse(source.sourceClosedAt));
  if (source.sourceAction === "review") return ["cancelled", "reclassified"].includes(source.sourceStatus);
  if (source.sourceAction === "hold") return ["active", "in_run"].includes(source.sourceStatus);
  return true;
}

// A source level is a decision, not an exchange-confirmed stop or a fill.
export function buildSourceControl(source, local, { asOf, observedAt }) {
  if (source && (source.sourceSignalId !== local.sourceSignalId || source.symbol !== local.symbol)) {
    throw new Error("source_control_identity_mismatch");
  }
  if (source && !validateSourceAction(source)) throw new Error("source_control_action_invalid");
  if (!Number.isFinite(Date.parse(asOf)) || !Number.isFinite(Date.parse(observedAt)) ||
      Date.parse(observedAt) - Date.parse(asOf) > 60_000 ||
      Date.parse(asOf) > Date.parse(observedAt) + 30_000) {
    throw new Error("source_control_snapshot_stale");
  }
  return {
    sourceSignalId: local.sourceSignalId, symbol: local.symbol,
    sourceAction: source?.sourceAction ?? "unknown",
    sourceStatus: source?.sourceStatus ?? null,
    sourceUpdatedAt: source?.sourceUpdatedAt ?? null,
    sourceTrailingStopLevel: source?.sourceTrailingStopLevel ?? null,
    sourceLastMilestone: source?.sourceLastMilestone ?? null,
    asOf, observedAt,
  };
}

export function sourceProtectionFloor(control, position) {
  if (!control || control.sourceAction !== "hold" ||
      control.sourceSignalId !== position.sourceSignalId || control.symbol !== position.symbol) return null;
  const level = control.sourceTrailingStopLevel;
  const milestone = control.sourceLastMilestone;
  const isBtc = position.symbol.replace(/[-_/]/g, "").toUpperCase() === "BTCUSDT";
  // BTC has its separately approved 1% policy; do not infer a new BTC threshold.
  const breakEven = !isBtc && milestone !== null && milestone !== undefined &&
    Number.isFinite(Number(milestone)) && Number(milestone) >= 5
    ? Number(position.entryPrice) : 0;
  const trailing = level !== null && level !== undefined &&
    Number.isFinite(Number(level)) && Number(level) > 0 ? Number(level) : 0;
  const floor = Math.max(breakEven, trailing);
  return floor > 0 ? floor : null;
}

export function applySourceProtection(result, position, control, price, { observedAt = result.next.observedAt } = {}) {
  const floor = sourceProtectionFloor(control, position);
  if (floor === null || result.actions.some(action => action.type.startsWith("close_"))) return result;
  const next = { ...result.next };
  const actions = [...result.actions];
  for (const leg of ["core", "runner"]) {
    if (!position[`${leg}Open`] || !(Number(position[`${leg}Qty`]) > 0)) continue;
    const field = leg === "core" ? "stopPrice" : "runnerStopPrice";
    if (!(floor > Number(position[field]))) continue;
    const reason = floor <= Number(position.entryPrice) ? "breakeven_stop" : "percentage_point_trailing_stop";
    const existingIndex = actions.findIndex(action => action.type === "raise_stop" && action.leg === leg);
    const target = Math.max(floor, Number(next[field]));
    if (price <= target) {
      // A crossed floor cannot be installed above the market or filled at the historic level.
      if (existingIndex >= 0) actions.splice(existingIndex, 1);
      const quantity = Number(position[`${leg}Qty`]);
      next[`${leg}Qty`] = 0;
      next[`${leg}Open`] = false;
      next.remainingQty = Math.max(0, Number(next.remainingQty) - quantity);
      next[field] = position[field]; // no unexecuted stop upgrade
      actions.push({ type: `close_${leg}`, leg, quantity, price, reason,
        sourceProtection: { ...control, requestedStopPrice: floor } });
    } else {
      next[field] = target;
      const action = { type: "raise_stop", leg, quantity: Number(position[`${leg}Qty`]),
        stopPrice: target, reason, sourceProtection: { ...control, requestedStopPrice: floor } };
      if (existingIndex >= 0) actions[existingIndex] = action;
      else actions.push(action);
    }
  }
  if (next.remainingQty === 0) {
    next.status = "closed";
    if (position.mode === "paper") next.closedAt = observedAt;
  }
  return { ...result, next, actions };
}

/** Observe prices without making a strategy decision. Only explicit source
 * stop levels may create protection updates; milestones/peaks are not orders. */
export function evaluateSourceFollower(position, control, price, { observedAt } = {}) {
  if (!Number.isFinite(Number(price)) || Number(price) <= 0) {
    throw new TypeError("Source follower requires a verified positive market price");
  }
  const next = { ...position, lastPrice: Number(price), observedAt,
    peakPrice: Math.max(Number(position.peakPrice) || 0, Number(price)) };
  const actions = [];
  const observationTime = Date.parse(observedAt ?? "");
  const sourceTime = Date.parse(control?.observedAt ?? control?.asOf ?? "");
  const fresh = Number.isFinite(observationTime) && Number.isFinite(sourceTime) &&
    observationTime - sourceTime <= 120_000 && sourceTime - observationTime <= 2_000;
  const matched = fresh && control?.sourceAction === "hold" &&
    control.sourceSignalId === position.sourceSignalId &&
    control.symbol === position.symbol;
  const levels = matched ? [control.sourceStopLossPrice, control.sourceTrailingStopLevel]
    .filter(value => value !== null && value !== undefined &&
      Number.isFinite(Number(value)) && Number(value) > 0).map(Number) : [];
  const stop = levels.length ? Math.max(...levels) : null;
  next.strategyAuthority = "source";
  next.sourceFollower = { sourceAction: matched ? "hold" : control?.sourceAction ?? "unknown",
    requestedStopPrice: stop, observationFresh: fresh, observedAt };
  if (stop === null) return { next, actions };
  // A crossed source level is not a source close instruction. Never invent
  // a fill there or manufacture a market exit while the source still holds.
  if (Number(price) <= stop) {
    next.sourceFollower.stopUpdateStatus = "crossed_source_stop_waiting_for_close";
    return { next, actions };
  }
  for (const leg of ["core", "runner"]) {
    const field = leg === "core" ? "stopPrice" : "runnerStopPrice";
    if (!position[`${leg}Open`] || !(Number(position[`${leg}Qty`]) > 0)) continue;
    if (stop <= Number(position[field])) continue; // no unapproved loss of protection
    next[field] = stop;
    actions.push({ type: "raise_stop", leg, quantity: Number(position[`${leg}Qty`]),
      stopPrice: stop, reason: "source_protective_stop",
      sourceProtection: { ...control, requestedStopPrice: stop } });
  }
  return { next, actions };
}

export function createSourceControlStore(pool) {
  return {
    async getSourceControl(sourceSignalId) {
      const result = await pool.query(
        `SELECT detail FROM vst_events WHERE source_signal_id = $1
         AND kind = 'source_position_control' ORDER BY id DESC LIMIT 1`, [sourceSignalId],
      );
      return result.rows[0]?.detail ?? null;
    },
    async syncSourceControls({ positions, asOf, observedAt }) {
      if (!(positions instanceof Map)) throw new TypeError("source controls require a complete Map");
      const observedIso = new Date(observedAt).toISOString();
      const client = await pool.connect();
      const refusals = [];
      try {
        await client.query("BEGIN");
        const locals = await client.query(
          `SELECT p.source_signal_id, p.symbol FROM vst_positions p
           JOIN vst_signals s ON s.source_signal_id = p.source_signal_id
           WHERE p.status IN ('open', 'closing', 'unknown')
           ORDER BY p.source_signal_id FOR UPDATE OF s`,
        );
        for (const row of locals.rows) {
          const local = { sourceSignalId: row.source_signal_id, symbol: row.symbol };
          let control;
          try {
            control = buildSourceControl(positions.get(row.source_signal_id), local,
              { asOf, observedAt: observedIso });
          } catch (error) {
            if (error.message !== "source_control_identity_mismatch") throw error;
            // Isolate a conflicting identity; never let it suppress commands
            // or protection admissions for other independently matched signals.
            control = buildSourceControl(null, local, { asOf, observedAt: observedIso });
            control.sourceIssue = "source_control_identity_mismatch";
            refusals.push({ sourceSignalId: local.sourceSignalId, reason: control.sourceIssue });
          }
          const existing = await client.query(
            `SELECT id, detail FROM vst_events WHERE source_signal_id = $1
             AND kind = 'source_position_control' ORDER BY id DESC LIMIT 1`, [row.source_signal_id],
          );
          const prior = existing.rows[0];
          // A late consumer cannot undo a newer source observation.
          if (prior && Date.parse(prior.detail.asOf) > Date.parse(asOf)) continue;
          // Persist the actual source fields, not an invented historical
          // maximum. Exchange-side no-loss-of-protection guards are separate.
          if (prior) await client.query(
            `UPDATE vst_events SET detail = $2::jsonb WHERE id = $1`,
            [prior.id, JSON.stringify(control)],
          );
          else await client.query(
            `INSERT INTO vst_events (source_signal_id, kind, detail)
             VALUES ($1, 'source_position_control', $2::jsonb)`,
            [row.source_signal_id, JSON.stringify(control)],
          );
        }
        await client.query("COMMIT");
        return { refusals };
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
    },
    async recordSourceControlExchangeObservation(control, observation) {
      if (!["review", "unknown"].includes(control?.sourceAction) ||
          observation?.verified !== true ||
          typeof observation.positionId !== "string" ||
          !(Number(observation.quantity) > 0)) return false;
      const result = await pool.query(
        `UPDATE vst_events SET detail = jsonb_set(detail, '{exchangeObservation}', $4::jsonb)
         WHERE source_signal_id = $1 AND kind = 'source_position_control'
         AND detail->>'asOf' = $2 AND detail->>'sourceAction' = $3
         AND detail->>'symbol' = $5`,
        [control.sourceSignalId, control.asOf, control.sourceAction,
          JSON.stringify(observation), control.symbol],
      );
      return result.rowCount > 0;
    },
  };
}