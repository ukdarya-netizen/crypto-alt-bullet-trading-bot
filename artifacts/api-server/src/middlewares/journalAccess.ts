import { getAuth } from "@clerk/express";
import type { RequestHandler } from "express";

export const requireJournalSession: RequestHandler = (req, res, next) => {
  if (!getAuth(req).userId) {
    res.status(401).json({ error: "SIGN_IN_REQUIRED" });
    return;
  }
  next();
};

export const requireJournalOwner: RequestHandler = (req, res, next) => {
  const owner = process.env.JOURNAL_OWNER_USER_ID;
  if (!owner || getAuth(req).userId !== owner) {
    res.status(403).json({ error: "OWNER_ACCESS_REQUIRED" });
    return;
  }
  next();
};