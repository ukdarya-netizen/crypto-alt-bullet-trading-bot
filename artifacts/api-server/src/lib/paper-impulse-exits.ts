import Decimal from "decimal.js";

export type ImpulseExitReason = "stop" | "trailing" | "recorded_legacy_time_exit" | "runner_five_day";

export function splitImpulseQuantity(quantity: string) {
  const total = new Decimal(quantity);
  if (!total.isFinite() || total.lte(0) || total.decimalPlaces() > 12) {
    throw new Error("Invalid impulse paper quantity");
  }
  const core = total.mul("0.8").toDecimalPlaces(12, Decimal.ROUND_DOWN);
  const runner = total.minus(core).toDecimalPlaces(12, Decimal.ROUND_DOWN);
  if (core.lte(0) || runner.lte(0) || !core.plus(runner).eq(total)) {
    throw new Error("Impulse paper quantity cannot be split into core and runner");
  }
  return { core: core.toFixed(12), runner: runner.toFixed(12) };
}

export function nextImpulsePaperProtection(input: {
  entry: string;
  initialStop: string;
  coreStop: string;
  corePeak: string;
  runnerStop: string;
  runnerPeak: string;
  price: string;
  symbol: string;
  entryAt: Date;
  now: Date;
  coreMaxHoldHours?: number;
  coreActive?: boolean;
  runnerActive?: boolean;
}) {
  const entry = new Decimal(input.entry);
  const price = new Decimal(input.price);
  const initialStop = new Decimal(input.initialStop);
  let coreStop = new Decimal(input.coreStop);
  let corePeak = new Decimal(input.corePeak);
  let runnerStop = new Decimal(input.runnerStop);
  let runnerPeak = new Decimal(input.runnerPeak);
  if (![entry, price, initialStop, coreStop, corePeak, runnerStop, runnerPeak]
    .every((value) => value.isFinite() && value.gt(0)) ||
    initialStop.gte(entry) || coreStop.gte(entry) && corePeak.eq(entry) ||
    runnerStop.gt(entry) && runnerPeak.eq(entry)) {
    throw new Error("Invalid impulse paper protection state");
  }

  let coreReason: ImpulseExitReason | null = null;
  let runnerReason: ImpulseExitReason | null = null;
  if (input.coreActive !== false) {
    corePeak = Decimal.max(corePeak, price);
    const coreGain = corePeak.div(entry).minus(1).mul(100);
    if (coreGain.gte(input.symbol === "BTCUSDT" ? 1 : 5)) coreStop = Decimal.max(coreStop, entry);
    if (coreGain.gte(10)) coreStop = Decimal.max(coreStop, entry.mul("1.05"));
    if (coreGain.gte(15)) {
      coreStop = Decimal.max(coreStop, entry.mul(coreGain.minus(10).div(100).plus(1)));
    }
    if (price.lte(coreStop)) coreReason = coreGain.gte(15) ? "trailing" : "stop";
    else if (input.coreMaxHoldHours !== undefined &&
        input.now.getTime() - input.entryAt.getTime() >= input.coreMaxHoldHours * 3_600_000) {
      coreReason = "recorded_legacy_time_exit";
    }
  }

  // Runner opens with its stop at break-even. Preserve this floor even for
  // entries created before the initial paper state was recorded.
  runnerStop = Decimal.max(runnerStop, entry);

  if (input.runnerActive !== false) {
    runnerPeak = Decimal.max(runnerPeak, price);
    const runnerGain = runnerPeak.div(entry).minus(1).mul(100);
    if (runnerGain.gte(30)) {
      runnerStop = Decimal.max(runnerStop, entry.mul(runnerGain.minus(30).div(100).plus(1)));
    }
    if (price.lte(runnerStop)) runnerReason = runnerGain.gte(30) ? "trailing" : "stop";
    else if (input.now.getTime() - input.entryAt.getTime() >= 120 * 60 * 60 * 1000) {
      runnerReason = "runner_five_day";
    }
  }

  const format = (value: Decimal) => value.toDecimalPlaces(12, Decimal.ROUND_DOWN).toFixed(12);
  return {
    coreStop: format(coreStop),
    corePeak: format(corePeak),
    runnerStop: format(runnerStop),
    runnerPeak: format(runnerPeak),
    coreReason,
    runnerReason,
  };
}