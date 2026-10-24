import { evaluatePosition } from "./engine.mjs";

export const SCENARIO_VERSION = "prospective_observed_quotes_v1";

// A reporting-only shadow of a PAPER entry. Never pass these snapshots to
// order execution or to the PAPER wallet.
export function startScenarios(position) {
  const base = { ...position };
  delete base.scenarioModel;
  const impulse = base.patternId === "impulse_buy" && base.runnerQty > 0;
  const coreQty = impulse ? base.coreQty : base.quantity;
  const ordinary = {
    ...base,
    patternId: "price_led_momentum",
    coreQty,
    remainingQty: coreQty,
    runnerQty: 0,
    runnerOpen: false,
    runnerStopPrice: null,
    rules: { ...base.rules },
    milestones: { ...base.milestones },
  };
  const ladder = {
    ...ordinary,
    paperExitPolicy: {
      ...base.paperExitPolicy,
      mode: "ladder_25_25_50",
      status: "active",
      firstTargetExecuted: false,
      secondTargetExecuted: false,
      thirdTargetExecuted: false,
    },
  };
  const scalp = {
    ...ordinary,
    // Scalp owns 100% until its single +5% exit; even Impulse Buy has no
    // separate runner in this strategy.
    coreQty: base.quantity,
    remainingQty: base.quantity,
    paperExitPolicy: { ...base.paperExitPolicy, mode: "classic", status: "active" },
  };
  const rate = Number(position.feeModel?.rate);
  const validRate = Number.isFinite(rate) && rate >= 0 && rate < 0.1;
  const runner = impulse ? {
    ...base,
    quantity: base.runnerQty,
    remainingQty: base.runnerQty,
    coreQty: 0,
    coreOpen: false,
    runnerOpen: true,
    runnerStopPrice: base.entryPrice,
    paperExitPolicy: { ...base.paperExitPolicy, mode: "impulse_25_25_core_runner" },
  } : null;
  const shadow = (position, withRunner = true) => ({
    position, runner: withRunner ? runner : null, exits: [],
    costUsdt: validRate ? base.entryPrice * base.quantity * rate : null,
    status: validRate ? "open" : "incomplete",
  });
  return {
    version: SCENARIO_VERSION,
    costBasis: "entry and exit at entry's observed PAPER taker rate; funding excluded",
    variants: {
      "1": shadow({
        ...base,
        paperExitPolicy: {
          version: "observed_classic_scenario_v1",
          mode: "classic",
          status: "active",
        },
      }, false),
      "2": shadow(scalp, false),
      "3": shadow(ladder),
      "4": { ...shadow(base), runner: null },
    },
  };
}

export function observeScenarios(model, { price, bid, at }) {
  if (model?.version !== SCENARIO_VERSION) return model;
  const variants = {};
  for (const [id, variant] of Object.entries(model.variants)) {
    if (variant.status !== "open") {
      variants[id] = variant;
      continue;
    }
    const prior = variant.position;
    const scalpTarget = id === "2" && price >= prior.entryPrice * 1.05 &&
      price > prior.stopPrice && prior.status === "open";
    const result = prior.status === "closed" ? { next: prior, actions: [] } : scalpTarget ? {
      next: { ...prior, remainingQty: 0, coreQty: 0, coreOpen: false, status: "closed" },
      actions: [{ type: "close_all", quantity: prior.remainingQty, reason: "scalp_target" }],
    } : evaluatePosition(prior, { price, at });
    let runnerResult = null;
    if (variant.runner?.status === "open") {
      const target = (id === "2" && scalpTarget) ||
        (id === "3" && result.next.paperExitPolicy?.thirdTargetExecuted);
      runnerResult = target ? {
        next: { ...variant.runner, remainingQty: 0, runnerQty: 0, runnerOpen: false, status: "closed" },
        actions: [{ type: "close_runner", quantity: variant.runner.remainingQty, reason: "final_target_runner" }],
      } : evaluatePosition(variant.runner, { price, at });
    }
    const closes = [
      ...result.actions.filter((action) => action.type !== "raise_stop"),
      ...(runnerResult?.actions.filter((action) => action.type !== "raise_stop") ?? []),
    ];
    if (closes.length && !(Number.isFinite(bid) && bid > 0)) {
      variants[id] = { ...variant, status: "incomplete", reason: "missing_bid_at_exit" };
      continue;
    }
    const rate = Number(prior.feeModel?.rate);
    const exits = [...variant.exits, ...closes.map((action) => ({
      at, quantity: action.quantity, price: bid, reason: action.reason,
      grossUsdt: action.quantity * (bid - prior.entryPrice),
      estimatedFeeUsdt: action.quantity * bid * rate,
    }))];
    variants[id] = {
      ...variant,
      position: result.next,
      runner: runnerResult?.next ?? variant.runner,
      exits,
      costUsdt: variant.costUsdt + closes.reduce((sum, action) => sum + action.quantity * bid * rate, 0),
      status: result.next.status === "closed" && (!runnerResult || runnerResult.next.status === "closed") ? "closed" : "open",
      closedAt: result.next.status === "closed" && (!runnerResult || runnerResult.next.status === "closed") ? at : null,
    };
  }
  return { ...model, variants };
}