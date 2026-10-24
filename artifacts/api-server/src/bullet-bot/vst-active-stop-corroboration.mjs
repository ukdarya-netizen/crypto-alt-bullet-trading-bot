import { compareExactDecimals } from "./vst-exact-decimal.mjs";

const POSITION_ID_FIELDS = ["positionId", "positionID"];
const ORDER_ID_FIELDS = ["orderId", "orderID"];
const EXECUTION_FIELDS = [
  "executedQty", "executedQuantity", "cumExecQty", "filledQty",
];

function suppliedValues(row, fields) {
  const supplied = fields.filter((field) => Object.hasOwn(row, field));
  if (supplied.some((field) => row[field] === undefined || row[field] === null)) {
    return null;
  }
  return supplied.map((field) => row[field]);
}

function exactIdentifier(value) {
  if (typeof value === "string" && value.trim() !== "") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

function exactRealPositionIdentifier(value, expected) {
  const identifier = exactIdentifier(value);
  return identifier !== null &&
    !/^0+$/.test(identifier) &&
    identifier === expected;
}

function exactAliases(row, fields, expected) {
  const values = suppliedValues(row, fields);
  return values !== null && values.length > 0 &&
    values.every((value) => exactIdentifier(value) === expected);
}

function exactPositionAliases(row, expected) {
  const values = suppliedValues(row, POSITION_ID_FIELDS);
  return values !== null && values.length > 0 &&
    values.every((value) => exactRealPositionIdentifier(value, expected));
}

function zeroPositionAliases(row) {
  const values = suppliedValues(row, POSITION_ID_FIELDS);
  return values !== null && values.length > 0 &&
    values.every((value) => value === 0 || value === "0");
}

function explicitZeroExecution(row, { requireAny = false } = {}) {
  const values = suppliedValues(row, EXECUTION_FIELDS);
  return values !== null && (!requireAny || values.length > 0) &&
    values.every((value) => compareExactDecimals(value, "0") === 0);
}

function positiveDecimal(value) {
  return compareExactDecimals(value, "0") === 1;
}

/**
 * Corroborate the one known VST active conditional-order query representation
 * where the provider reports zero position IDs. The open-order row must be an
 * independently retrieved, exactly linked active order; all other query
 * identity and specification fields remain untouched and must match it.
 */
export function corroborateVstActiveStopPosition(row, openRow, {
  orderId, positionId,
} = {}) {
  if (!row || typeof row !== "object" || !openRow ||
      typeof openRow !== "object" ||
      typeof orderId !== "string" || !orderId ||
      typeof positionId !== "string" || !positionId || positionId === "0") {
    return null;
  }

  if (!exactAliases(row, ORDER_ID_FIELDS, orderId) ||
      !exactAliases(openRow, ORDER_ID_FIELDS, orderId) ||
      !zeroPositionAliases(row) ||
      !exactPositionAliases(openRow, positionId) ||
      !explicitZeroExecution(row, { requireAny: true }) ||
      !explicitZeroExecution(openRow, { requireAny: true })) {
    return null;
  }

  const exactActiveFields = [
    "symbol", "status", "type", "side", "positionSide", "workingType",
  ];
  if (exactActiveFields.some((field) =>
    typeof row[field] !== "string" || row[field] !== openRow[field]) ||
      row.status !== "NEW" || row.type !== "STOP_MARKET" ||
      row.side !== "SELL" || row.positionSide !== "LONG" ||
      row.workingType !== "MARK_PRICE" ||
      !positiveDecimal(row.origQty) || !positiveDecimal(openRow.origQty) ||
      compareExactDecimals(row.origQty, openRow.origQty) !== 0 ||
      !positiveDecimal(row.stopPrice) || !positiveDecimal(openRow.stopPrice) ||
      compareExactDecimals(row.stopPrice, openRow.stopPrice) !== 0) {
    return null;
  }

  const corroborated = { ...row };
  for (const field of POSITION_ID_FIELDS) {
    if (Object.hasOwn(corroborated, field)) corroborated[field] = positionId;
  }
  return corroborated;
}