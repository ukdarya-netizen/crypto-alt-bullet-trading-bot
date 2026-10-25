import { clerkClient, getAuth } from "@clerk/express";
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireJournalOwner, requireJournalSession } from "../middlewares/journalAccess";
import { vstPerformanceRow } from "../lib/vst-performance";
// @ts-expect-error JavaScript module of the bot.
import { encryptSecret, forbiddenPermissions, plausibleBingXKey, readBingXKeyPermissions, subscriberKeysConfigured } from "../bullet-bot/subscriber-keys.mjs";
// @ts-expect-error JavaScript module of the bot.
import { createBingXLiveApi, createBingXOutboundPacer } from "../bullet-bot/bingx-live-api.mjs";
// @ts-expect-error JavaScript module of the bot.
import { SUBSCRIBER_STRATEGIES, ensureSubscribersTable, subscriberSchema } from "../bullet-bot/subscriber-trading.mjs";
// @ts-expect-error JavaScript module of the bot.
import { ALLOCATION_LIMITS, SUBSCRIBER_LEVERAGE_CHOICES, normalizePositionProfile } from "../bullet-bot/vst-position-profile.mjs";

/**
 * Subscribers (owner's family first):
 *  - any signed-in person gets a pending request on first visit;
 *  - the owner approves / rejects / blocks in the journal;
 *  - an approved subscriber saves a BingX key (verified with a read-only
 *    VST balance request, then stored encrypted), picks a strategy and
 *    starts/stops trading. Phase 1: BingX VST demo only.
 * Keys are never returned by any endpoint.
 */
const router: IRouter = Router();

type Row = Record<string, unknown> & { id: number; status: string };
const strategies = SUBSCRIBER_STRATEGIES as Record<string, { label: string; available: boolean }>;

function publicView(row: Row) {
  return {
    id: row.id,
    status: row.status,
    email: row.email ?? null,
    name: row.name ?? null,
    requestedAt: row.requested_at,
    strategy: row.strategy ?? null,
    apiKeyLast4: row.api_key_last4 ?? null,
    apiKeyVerifiedAt: row.api_key_verified_at ?? null,
    apiKeyError: row.api_key_error ?? null,
    positionSettings: {
      allocationMode: (row.allocation_mode as string | undefined) ?? "percent",
      allocationValue: Number(row.allocation_value ?? 1),
      leverage: Number(row.leverage ?? 10),
      marginMode: (row.margin_mode as string | undefined) ?? "ISOLATED",
    },
    tradingEnabled: Boolean(row.trading_enabled),
    tradingStartedAt: row.trading_started_at ?? null,
    runtimeStatus: row.runtime_status ?? null,
    runtimeReason: row.runtime_reason ?? null,
    runtimeAt: row.runtime_at ?? null,
  };
}

async function subscriberFor(req: Request): Promise<Row> {
  const userId = getAuth(req).userId!;
  const existing = await pool.query("SELECT * FROM subscribers WHERE clerk_user_id = $1", [userId]);
  if (existing.rows[0]) return existing.rows[0] as Row;
  let email: string | null = null;
  let name: string | null = null;
  try {
    const user = await clerkClient.users.getUser(userId);
    email = user.primaryEmailAddress?.emailAddress ?? null;
    name = [user.firstName, user.lastName].filter(Boolean).join(" ") || null;
  } catch {}
  const inserted = await pool.query(
    `INSERT INTO subscribers (clerk_user_id, email, name) VALUES ($1, $2, $3)
     ON CONFLICT (clerk_user_id) DO UPDATE SET clerk_user_id = EXCLUDED.clerk_user_id
     RETURNING *`,
    [userId, email, name],
  );
  return inserted.rows[0] as Row;
}

function refuse(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

async function schemaExists(id: number): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'vst_positions'",
    [subscriberSchema(id)],
  );
  return Boolean(result.rowCount);
}

async function performance(id: number) {
  if (!(await schemaExists(id))) return { trades: [], openPositions: 0 };
  const schema = subscriberSchema(id) as string;
  const [closed, open] = await Promise.all([
    pool.query(
      `SELECT p.source_signal_id, p.symbol, p.snapshot, p.updated_at, s.body->>'patternId' AS pattern_id
       FROM ${schema}.vst_positions p LEFT JOIN ${schema}.vst_signals s ON s.source_signal_id = p.source_signal_id
       WHERE p.status = 'closed' ORDER BY p.updated_at DESC LIMIT 2000`,
    ),
    pool.query(`SELECT count(*)::int AS n FROM ${schema}.vst_positions WHERE status IN ('open','closing','unknown')`),
  ]);
  return { trades: closed.rows.map(vstPerformanceRow), openPositions: open.rows[0]?.n ?? 0 };
}

// The table creates itself on first use (no drizzle push needed).
router.use(["/me", "/journal/subscribers"], async (_req, _res, next) => {
  try {
    await ensureSubscribersTable(pool);
    next();
  } catch (error) {
    next(error);
  }
});

// ---------------- subscriber (any signed-in person) ----------------

router.use("/me", requireJournalSession);

router.get("/me/subscription", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const row = await subscriberFor(req);
  res.json({
    subscription: publicView(row),
    strategies: Object.entries(strategies).map(([id, s]) => ({ id, label: s.label, available: s.available })),
    keysConfigured: subscriberKeysConfigured(),
    positionChoices: { leverage: SUBSCRIBER_LEVERAGE_CHOICES, allocation: ALLOCATION_LIMITS },
  });
});

router.get("/me/performance", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  res.json(await performance(row.id));
});

router.post("/me/api-key", async (req, res) => {
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  if (!subscriberKeysConfigured()) {
    return refuse(res, 503, "keys_secret_missing", "Хранилище ключей не настроено владельцем");
  }
  const apiKey = String(req.body?.apiKey ?? "").trim();
  const apiSecret = String(req.body?.apiSecret ?? "").trim();
  if (!plausibleBingXKey(apiKey) || !plausibleBingXKey(apiSecret)) {
    return refuse(res, 422, "key_format", "Ключ и секрет — это латинские буквы и цифры из BingX");
  }
  // 1) The key must not be able to move money (withdraw / transfers).
  let permissions: number[];
  try {
    permissions = (await readBingXKeyPermissions({ key: apiKey, secret: apiSecret })).permissions;
  } catch (error) {
    const message = error instanceof Error ? error.message : "BingX error";
    await pool.query("UPDATE subscribers SET api_key_error = $2, updated_at = now() WHERE id = $1",
      [row.id, message.slice(0, 300)]);
    return refuse(res, 422, "key_permissions_unverified", `Не удалось проверить права ключа: ${message.slice(0, 200)}`);
  }
  const forbidden = forbiddenPermissions(permissions) as number[];
  if (forbidden.length) {
    await pool.query("UPDATE subscribers SET api_key_error = $2, updated_at = now() WHERE id = $1",
      [row.id, `key_has_money_moving_permissions:${forbidden.join(",")}`]);
    return refuse(res, 422, "key_can_withdraw",
      "У ключа включён вывод или перевод средств. Создайте ключ только с правами «чтение» и «торговля фьючерсами».");
  }
  // 2) Read-only check on the VST demo account with this exact key.
  const api = createBingXLiveApi({
    environment: "vst",
    credentials: () => ({ key: apiKey, secret: apiSecret }),
    requestPacer: createBingXOutboundPacer(),
    writePermission: () => false,
  });
  let balance: unknown = null;
  try {
    balance = await api.getBalance();
  } catch (error) {
    const message = error instanceof Error ? error.message : "BingX error";
    await pool.query("UPDATE subscribers SET api_key_error = $2, updated_at = now() WHERE id = $1",
      [row.id, message.slice(0, 300)]);
    return refuse(res, 422, "key_rejected", `BingX не принял ключ: ${message.slice(0, 200)}`);
  }
  await pool.query(
    `UPDATE subscribers SET api_key_encrypted = $2, api_secret_encrypted = $3, api_key_last4 = $4,
       api_key_verified_at = now(), api_key_error = NULL, version = version + 1, updated_at = now()
     WHERE id = $1`,
    [row.id, encryptSecret(apiKey), encryptSecret(apiSecret), apiKey.slice(-4)],
  );
  const vst = (balance as { balance?: { balance?: string; equity?: string } } | null)?.balance;
  res.json({ verified: true, balanceVst: vst?.balance ?? vst?.equity ?? null });
});

router.delete("/me/api-key", async (req, res) => {
  const row = await subscriberFor(req);
  await pool.query(
    `UPDATE subscribers SET api_key_encrypted = NULL, api_secret_encrypted = NULL, api_key_last4 = NULL,
       api_key_verified_at = NULL, trading_enabled = false, trading_stopped_at = now(),
       version = version + 1, updated_at = now()
     WHERE id = $1`,
    [row.id],
  );
  res.json({ removed: true });
});

router.post("/me/strategy", async (req, res) => {
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  const strategy = String(req.body?.strategy ?? "");
  if (!strategies[strategy]) return refuse(res, 422, "unknown_strategy", "Такой стратегии нет");
  if (!strategies[strategy].available) return refuse(res, 422, "strategy_not_available", "Эта стратегия пока в разработке");
  if (row.trading_enabled) return refuse(res, 409, "trading_running", "Сначала остановите торговлю");
  await pool.query("UPDATE subscribers SET strategy = $2, version = version + 1, updated_at = now() WHERE id = $1",
    [row.id, strategy]);
  res.json({ strategy });
});

router.post("/me/position-settings", async (req, res) => {
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  if (row.trading_enabled) return refuse(res, 409, "trading_running", "Сначала остановите торговлю");
  // Open positions are managed with the leverage/margin they were opened with.
  const perf = await performance(row.id);
  if (perf.openPositions > 0) {
    return refuse(res, 409, "positions_open", "Дождитесь закрытия открытых сделок, потом меняйте настройки");
  }
  const leverage = Number(req.body?.leverage);
  if (!(SUBSCRIBER_LEVERAGE_CHOICES as number[]).includes(leverage)) {
    return refuse(res, 422, "leverage", "Такого плеча нет в списке");
  }
  let profile: { leverage: number; marginMode: string; allocation: { mode: string; value: number } };
  try {
    profile = normalizePositionProfile({
      leverage,
      marginMode: String(req.body?.marginMode ?? ""),
      allocation: { mode: String(req.body?.allocationMode ?? ""), value: Number(req.body?.allocationValue) },
    });
  } catch {
    return refuse(res, 422, "position_settings", "Проверьте значения: процент от 0.1 до 100, сумма от 1");
  }
  await pool.query(
    `UPDATE subscribers SET allocation_mode = $2, allocation_value = $3, leverage = $4, margin_mode = $5,
       version = version + 1, updated_at = now() WHERE id = $1`,
    [row.id, profile.allocation.mode, String(profile.allocation.value), profile.leverage, profile.marginMode],
  );
  res.json({
    positionSettings: {
      allocationMode: profile.allocation.mode, allocationValue: profile.allocation.value,
      leverage: profile.leverage, marginMode: profile.marginMode,
    },
  });
});

router.post("/me/trading", async (req, res) => {
  const row = await subscriberFor(req);
  const enable = req.body?.enabled === true;
  if (enable) {
    if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
    if (!row.api_key_verified_at) return refuse(res, 422, "no_key", "Сначала добавьте и проверьте ключ BingX");
    if (!row.strategy || !strategies[String(row.strategy)]?.available) {
      return refuse(res, 422, "no_strategy", "Выберите стратегию");
    }
    await pool.query(
      "UPDATE subscribers SET trading_enabled = true, trading_started_at = now(), updated_at = now() WHERE id = $1",
      [row.id],
    );
  } else {
    await pool.query(
      "UPDATE subscribers SET trading_enabled = false, trading_stopped_at = now(), updated_at = now() WHERE id = $1",
      [row.id],
    );
  }
  res.json({ tradingEnabled: enable });
});

// ---------------- owner ----------------

router.get("/journal/subscribers", requireJournalSession, requireJournalOwner, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { rows } = await pool.query("SELECT * FROM subscribers ORDER BY status = 'pending' DESC, requested_at DESC");
  const list = await Promise.all((rows as Row[]).map(async (row) => {
    let stats = { closed: 0, netUsdt: 0, openPositions: 0 };
    if (row.status === "approved") {
      try {
        const perf = await performance(row.id);
        const known = perf.trades.filter((trade) => trade.pnlUsdt !== null);
        stats = {
          closed: perf.trades.length,
          netUsdt: Number(known.reduce((sum, trade) => sum + (trade.pnlUsdt ?? 0), 0).toFixed(4)),
          openPositions: perf.openPositions,
        };
      } catch {}
    }
    return { ...publicView(row), stats };
  }));
  res.json({ subscribers: list, keysConfigured: subscriberKeysConfigured() });
});

router.post("/journal/subscribers/:id/decision", requireJournalSession, requireJournalOwner, async (req, res) => {
  const id = Number(req.params.id);
  const decision = String(req.body?.decision ?? "");
  const status = { approve: "approved", reject: "rejected", block: "blocked", unblock: "approved" }[decision];
  if (!Number.isSafeInteger(id) || !status) return refuse(res, 422, "invalid_decision", "Неверное решение");
  const result = await pool.query(
    `UPDATE subscribers SET status = $2, decided_at = now(), decided_by = $3,
       trading_enabled = CASE WHEN $2 = 'approved' THEN trading_enabled ELSE false END,
       version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [id, status, getAuth(req).userId],
  );
  if (!result.rowCount) return refuse(res, 404, "not_found", "Подписчик не найден");
  res.json({ subscriber: publicView(result.rows[0] as Row) });
});

export default router;
