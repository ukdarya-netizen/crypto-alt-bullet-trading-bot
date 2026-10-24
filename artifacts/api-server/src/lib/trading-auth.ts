import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

type TokenKind = "ingest" | "control";

const tokenEnvKey: Record<TokenKind, string> = {
  ingest: "TRADING_INGEST_TOKEN",
  control: "TRADING_CONTROL_TOKEN",
};

function tokensMatch(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);

  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

export function requireTradingToken(kind: TokenKind): RequestHandler {
  return (req, res, next) => {
    const envKey = tokenEnvKey[kind];
    const expected = process.env[envKey];

    if (!expected) {
      res.status(503).json({
        error: "TRADING_AUTH_NOT_CONFIGURED",
        message: `${envKey} is not configured; mutating trading operations are disabled.`,
      });
      return;
    }

    const received = req.header("x-trading-token") ?? "";
    if (!tokensMatch(received, expected)) {
      res.status(401).json({
        error: "UNAUTHORIZED",
        message: "Missing or invalid trading token.",
      });
      return;
    }

    next();
  };
}