import assert from "node:assert/strict";
import { test } from "node:test";
import { exchangeHistoryClosedAccounting } from "./vst-closed-history";

function repairedSnapshot({
  entryPrice,
  quantity,
  closePrice,
  entryCommission,
  closeCommission,
  realisedPnl = "1.51021000",
  feeAsset = "VST",
}: {
  entryPrice: string;
  quantity: string;
  closePrice: string;
  entryCommission: string;
  closeCommission: string;
  realisedPnl?: string;
  feeAsset?: string;
}) {
  return {
    exchangeHistoryProvenance: {
      verified: true,
      environment: "vst",
      entryFill: {
        price: entryPrice,
        quantity,
        at: "2024-01-01T00:00:00.000Z",
        fee: { asset: feeAsset, amount: entryCommission },
      },
      closeFill: {
        price: closePrice,
        quantity,
        at: "2024-01-01T01:00:00.000Z",
        fee: { asset: feeAsset, amount: closeCommission },
        realisedPnl,
        realisedPnlAsset: "USDT",
        realisedPnlProvenance: "bingx_fill_history.realisedPNL",
      },
    },
  };
}

test("maps a verified history repair to gross and known-after-fees without claiming net PnL", () => {
  const mapped = exchangeHistoryClosedAccounting(repairedSnapshot({
    entryPrice: "0.5203",
    quantity: "18879.3",
    closePrice: "0.5204",
    entryCommission: "-4.911639",
    closeCommission: "-4.912394",
  }), "2024-01-01T01:00:00.000Z");

  assert.deepEqual(mapped, {
    closedByExchangeHistory: true,
    closedAt: "2024-01-01T01:00:00.000Z",
    entryPrice: "0.5203",
    entryFillAt: "2024-01-01T00:00:00.000Z",
    closePrice: "0.5204",
    closeQuantity: "18879.3",
    entryCommissionUsdt: -4.911639,
    closeCommissionUsdt: -4.912394,
    grossPnlUsdt: 1.51021,
    knownFeeExpenseUsdt: 9.824033,
    knownAfterFeesUsdt: null,
    feeAsset: "VST",
    fundingStatus: "unverified",
  });
});

test("uses the actual close quantity and signed entry and exit commissions", () => {
  const mapped = exchangeHistoryClosedAccounting(repairedSnapshot({
    entryPrice: "0.020162",
    quantity: "486594.7",
    closePrice: "0.018875",
    entryCommission: "-4.905391",
    closeCommission: "-4.592221",
    realisedPnl: "-626.34076770",
    feeAsset: "USDT",
  }), "2024-01-01T01:00:00.000Z");

  assert.equal(mapped?.grossPnlUsdt, -626.3407677);
  assert.equal(mapped?.knownFeeExpenseUsdt, 9.497612);
  assert.equal(mapped?.knownAfterFeesUsdt, -635.8383797);
  assert.equal(mapped?.fundingStatus, "unverified");
});

test("does not infer a zero commission or after-fees result when a signed fee is absent", () => {
  const snapshot = repairedSnapshot({
    entryPrice: "0.5203",
    quantity: "18879.3",
    closePrice: "0.5204",
    entryCommission: "-4.911639",
    closeCommission: "-4.912394",
  });
  const provenance = snapshot.exchangeHistoryProvenance;
  delete (provenance.closeFill.fee as { asset: string; amount: string }).amount;

  const mapped = exchangeHistoryClosedAccounting(snapshot, "2024-01-01T01:00:00.000Z");
  assert.equal(mapped?.grossPnlUsdt, 1.51021);
  assert.equal(mapped?.knownFeeExpenseUsdt, null);
  assert.equal(mapped?.knownAfterFeesUsdt, null);
});

test("never derives missing provider PnL from rounded prices", () => {
  const snapshot = repairedSnapshot({
    entryPrice: "0.5203", quantity: "18879.3", closePrice: "0.5204",
    entryCommission: "-4.911639", closeCommission: "-4.912394",
  });
  delete (snapshot.exchangeHistoryProvenance.closeFill as { realisedPnl?: string }).realisedPnl;
  const mapped = exchangeHistoryClosedAccounting(snapshot, "2024-01-01T01:00:00.000Z");
  assert.equal(mapped?.grossPnlUsdt, null);
  assert.equal(mapped?.knownAfterFeesUsdt, null);
  assert.equal(mapped?.knownFeeExpenseUsdt, 9.824033);
});

test("does not classify an unverified history object as an exchange-history close", () => {
  assert.equal(exchangeHistoryClosedAccounting({
    exchangeHistoryProvenance: { verified: false, environment: "vst" },
  }, "2024-01-01T01:00:00.000Z"), null);
});