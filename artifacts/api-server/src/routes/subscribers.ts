import { clerkClient, getAuth } from "@clerk/express";
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { requireJournalOwner, requireJournalSession } from "../middlewares/journalAccess";
import { vstPerformanceRow } from "../lib/vst-performance";
// @ts-expect-error JavaScript module of the bot.
import { decryptSecret, encryptSecret, forbiddenPermissions, plausibleBingXKey, readBingXKeyPermissions, subscriberKeysConfigured } from "../bullet-bot/subscriber-keys.mjs";
// @ts-expect-error JavaScript module of the bot.
import { REAL_ACCOUNT_CAPABILITY, createBingXLiveApi } from "../bullet-bot/bingx-live-api.mjs";
// @ts-expect-error JavaScript module of the bot.
import { SUBSCRIBER_STRATEGIES, ensureSubscribersTable, subscriberAccount, subscriberSchema, subscriberTelegramLabel, subscriberTradingStrategy } from "../bullet-bot/subscriber-trading.mjs";
// @ts-expect-error JavaScript module of the bot.
import { postTelegramMessage, redactTelegramError, validateTelegramCredentials } from "../bullet-bot/telegram-client.mjs";
// @ts-expect-error JavaScript module of the bot.
import { EXIT_CHOICES, TRADE_PATTERNS, TRADE_PATTERN_LABELS, describeTradingStrategy, resolveTradingStrategy } from "../bullet-bot/trading-strategy.mjs";
// @ts-expect-error JavaScript module of the bot.
import { loadOwnerStrategy, saveOwnerStrategy } from "../bullet-bot/owner-trading-strategy.mjs";
// @ts-expect-error JavaScript module of the bot.
import { loadStrategyPaper } from "../bullet-bot/strategy-paper.mjs";
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
    patternExit: (row.pattern_exit as string | null | undefined) ?? null,
    patterns: typeof row.patterns === "string" && row.patterns ? row.patterns.split(",") : [],
    strategyText: (() => {
      const resolved = subscriberTradingStrategy(row);
      return resolved ? describeTradingStrategy(resolved) : null;
    })(),
    apiKeyLast4: row.api_key_last4 ?? null,
    apiKeyVerifiedAt: row.api_key_verified_at ?? null,
    apiKeyError: row.api_key_error ?? null,
    positionSettings: {
      allocationMode: (row.allocation_mode as string | undefined) ?? "percent",
      allocationValue: Number(row.allocation_value ?? 1),
      leverage: Number(row.leverage ?? 10),
      marginMode: (row.margin_mode as string | undefined) ?? "ISOLATED",
    },
    tradingAccount: subscriberAccount(row) as "vst" | "real",
    realAllowed: Boolean(row.real_allowed),
    realKeyVerifiedAt: row.real_key_verified_at ?? null,
    keyIsOwnerMain: Boolean(row.key_is_owner_main),
    tradingEnabled: Boolean(row.trading_enabled),
    tradingStartedAt: row.trading_started_at ?? null,
    runtimeStatus: row.runtime_status ?? null,
    runtimeReason: row.runtime_reason ?? null,
    runtimeAt: row.runtime_at ?? null,
  };
}

/** The owner uses the same cabinet as a subscriber ("Мой кабинет"), approved at once. */
const isOwner = (userId: string | null | undefined) =>
  Boolean(userId) && userId === process.env.JOURNAL_OWNER_USER_ID;

async function subscriberFor(req: Request): Promise<Row> {
  const row = await findOrCreateSubscriber(req);
  const userId = getAuth(req).userId;
  if (isOwner(userId) && row.status !== "approved") {
    const approved = await pool.query(
      `UPDATE subscribers SET status = 'approved', real_allowed = true, decided_at = now(), decided_by = $2,
         version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
      [row.id, userId]);
    return approved.rows[0] as Row;
  }
  if (isOwner(userId) && !row.real_allowed) {
    const allowed = await pool.query(
      "UPDATE subscribers SET real_allowed = true, updated_at = now() WHERE id = $1 RETURNING *", [row.id]);
    return allowed.rows[0] as Row;
  }
  return row;
}

async function findOrCreateSubscriber(req: Request): Promise<Row> {
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
     RETURNING *, (xmax = 0) AS created`,
    [userId, email, name],
  );
  if (inserted.rows[0]?.created && userId !== process.env.JOURNAL_OWNER_USER_ID) {
    notifyOwner(inserted.rows[0] as Row, ["Новая заявка в торговый бот. Одобрить — страница «Подписчики».",
      email ? `E-mail: ${email}` : null]);
  }
  return inserted.rows[0] as Row;
}

// Owner 2026-10-29: every change in a cabinet is reported to the owner's
// Telegram chat (plain text). Never blocks or fails the request itself.
const ACCOUNT_NAME = (account: string) => (account === "real" ? "РЕАЛЬНЫЙ счёт" : "демо-счёт VST");
function notifyOwner(row: Row, lines: (string | null | undefined | false)[]) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const text = [subscriberTelegramLabel(row), ...lines.filter(Boolean)].join("\n");
  void (async () => {
    try {
      validateTelegramCredentials(token, chatId);
      await postTelegramMessage({ token, chatId, text, fetcher: fetch });
    } catch (error) {
      process.stderr.write(`Cabinet notice failed: ${redactTelegramError(error)}\n`);
    }
  })();
}
function sizeText(row: Row) {
  const unit = subscriberAccount(row) === "real" ? "USDT" : "VST";
  const size = row.allocation_mode === "amount" ? `${Number(row.allocation_value)} ${unit}` : `${Number(row.allocation_value)}% от баланса`;
  return `${size} · ${row.margin_mode === "CROSSED" ? "кросс" : "изолированная"} · ${Number(row.leverage)}x`;
}

function refuse(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

async function schemaExists(id: number, account: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'vst_positions'",
    [subscriberSchema(id, account)],
  );
  return Boolean(result.rowCount);
}

/** Read-only balance check of a key on the REAL BingX account (USDT). */
async function realAccountBalance(key: string, secret: string): Promise<string | null> {
  const api = createBingXLiveApi({
    environment: "vst", account: REAL_ACCOUNT_CAPABILITY,
    credentials: () => ({ key, secret }), writePermission: () => false,
  });
  const balance = await api.getBalance();
  const row = (balance as { balance?: { balance?: string; equity?: string } } | null)?.balance;
  return row?.balance ?? row?.equity ?? null;
}

/** Open positions on BOTH accounts (a switched-away account may still be closing trades). */
async function openPositionsAnywhere(id: number): Promise<number> {
  const [vst, real] = await Promise.all([performance(id, "vst"), performance(id, "real")]);
  return vst.openPositions + real.openPositions;
}

async function performance(id: number, account = "vst") {
  if (!(await schemaExists(id, account))) return { trades: [], openPositions: 0 };
  const schema = subscriberSchema(id, account) as string;
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
    strategyChoices: strategyChoices(),
    keysConfigured: subscriberKeysConfigured(),
    positionChoices: { leverage: SUBSCRIBER_LEVERAGE_CHOICES, allocation: ALLOCATION_LIMITS },
  });
});

router.get("/me/strategy-paper", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  res.json(await loadStrategyPaper(pool, { patterns: patternsQuery(req), days: daysQuery(req) }));
});

router.get("/me/performance", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  const perf = await performance(row.id, subscriberAccount(row));
  res.json({ ...perf, openPositions: await openPositionsAnywhere(row.id) });
});

router.post("/me/api-key", async (req, res) => {
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  if (!subscriberKeysConfigured()) {
    return refuse(res, 503, "keys_secret_missing", "Хранилище ключей не настроено владельцем");
  }
  if ((await openPositionsAnywhere(row.id)) > 0) {
    return refuse(res, 409, "positions_open", "Есть открытые сделки: ключ можно заменить после их закрытия");
  }
  const apiKey = String(req.body?.apiKey ?? "").trim();
  const apiSecret = String(req.body?.apiSecret ?? "").trim();
  if (!plausibleBingXKey(apiKey) || !plausibleBingXKey(apiSecret)) {
    return refuse(res, 422, "key_format", "Ключ и секрет — это латинские буквы и цифры из BingX");
  }
  // The owner's main bot trades the DEMO (VST) account of BINGX_API_KEY. The
  // same key is fine for REAL, but never for a second bot on that demo account.
  const keyIsOwnerMain = Boolean(process.env.BINGX_API_KEY) && apiKey === process.env.BINGX_API_KEY!.trim();
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
  // 3) Read-only check on the REAL account; failure only means REAL is unavailable.
  let balanceReal: string | null = null;
  let realOk = false;
  try { balanceReal = await realAccountBalance(apiKey, apiSecret); realOk = true; } catch {}
  await pool.query(
    `UPDATE subscribers SET api_key_encrypted = $2, api_secret_encrypted = $3, api_key_last4 = $4,
       api_key_verified_at = now(), api_key_error = NULL, key_is_owner_main = $5,
       real_key_verified_at = CASE WHEN $6 THEN now() ELSE NULL END,
       version = version + 1, updated_at = now()
     WHERE id = $1`,
    [row.id, encryptSecret(apiKey), encryptSecret(apiSecret), apiKey.slice(-4), keyIsOwnerMain, realOk],
  );
  const vst = (balance as { balance?: { balance?: string; equity?: string } } | null)?.balance;
  notifyOwner(row, [`Ключ BingX сохранён (••••${apiKey.slice(-4)}).`,
    `Демо-счёт: ключ подходит. Реальный счёт: ${realOk ? "ключ подходит" : "ключ НЕ принят"}.`]);
  res.json({ verified: true, balanceVst: vst?.balance ?? vst?.equity ?? null, balanceReal, realVerified: realOk });
});

router.delete("/me/api-key", async (req, res) => {
  const row = await subscriberFor(req);
  // Without the key the bot cannot manage open positions (stop, take, close).
  if ((await openPositionsAnywhere(row.id)) > 0) {
    return refuse(res, 409, "positions_open", "Есть открытые сделки: ключ можно удалить после их закрытия");
  }
  await pool.query(
    `UPDATE subscribers SET api_key_encrypted = NULL, api_secret_encrypted = NULL, api_key_last4 = NULL,
       api_key_verified_at = NULL, real_key_verified_at = NULL, key_is_owner_main = false, trading_enabled = false, trading_stopped_at = now(),
       version = version + 1, updated_at = now()
     WHERE id = $1`,
    [row.id],
  );
  notifyOwner(row, ["Ключ BingX удалён. Торговля остановлена."]);
  res.json({ removed: true });
});

/** Choices for the strategy pickers (subscriber cabinet and owner journal). */
function strategyChoices() {
  return {
    strategies: Object.entries(strategies).map(([id, s]) => ({ id, label: s.label })),
    exits: Object.entries(EXIT_CHOICES as Record<string, { label: string }>)
      .map(([id, e]) => ({ id, label: e.label })),
    patterns: (TRADE_PATTERNS as string[]).map((id) => ({
      id, label: (TRADE_PATTERN_LABELS as Record<string, string>)[id] })),
  };
}

type StrategyChoice = { strategy: string; patternExit: string | null; patterns: string[] | null };
function strategyChoiceFrom(body: unknown): StrategyChoice | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const choice = {
    strategy: String(b.strategy ?? ""),
    patternExit: b.strategy === "patterns" ? String(b.patternExit ?? "") : null,
    patterns: b.strategy === "patterns" && Array.isArray(b.patterns) ? b.patterns.map(String) : null,
  };
  try {
    const resolved = resolveTradingStrategy(choice);
    return { strategy: resolved.strategy, patternExit: resolved.patternExit ?? null,
      patterns: resolved.patterns ?? null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "invalid_strategy" };
  }
}
const STRATEGY_ERRORS: Record<string, string> = {
  unknown_strategy: "Такой стратегии нет",
  pattern_exit_required: "Выберите выход для стратегии «По паттернам»",
  patterns_must_be_1_to_3_of_4: "Выберите от 1 до 3 паттернов",
};

router.post("/me/strategy", async (req, res) => {
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  const choice = strategyChoiceFrom(req.body);
  if ("error" in choice) return refuse(res, 422, choice.error, STRATEGY_ERRORS[choice.error] ?? "Неверная стратегия");
  if (row.trading_enabled) return refuse(res, 409, "trading_running", "Сначала остановите торговлю");
  await pool.query(
    `UPDATE subscribers SET strategy = $2, pattern_exit = $3, patterns = $4,
       version = version + 1, updated_at = now() WHERE id = $1`,
    [row.id, choice.strategy, choice.patternExit, choice.patterns?.join(",") ?? null]);
  {
    const resolved = subscriberTradingStrategy({ strategy: choice.strategy, pattern_exit: choice.patternExit,
      patterns: choice.patterns?.join(",") ?? null });
    notifyOwner(row, [`Стратегия изменена: ${resolved ? describeTradingStrategy(resolved) : choice.strategy}.`]);
  }
  res.json(choice);
});

router.post("/me/position-settings", async (req, res) => {
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  if (row.trading_enabled) return refuse(res, 409, "trading_running", "Сначала остановите торговлю");
  // Open positions are managed with the leverage/margin they were opened with.
  if ((await openPositionsAnywhere(row.id)) > 0) {
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
  notifyOwner(row, [`Размер сделки изменён: ${sizeText({ ...row, allocation_mode: profile.allocation.mode,
    allocation_value: profile.allocation.value, leverage: profile.leverage, margin_mode: profile.marginMode } as Row)}.`]);
  res.json({
    positionSettings: {
      allocationMode: profile.allocation.mode, allocationValue: profile.allocation.value,
      leverage: profile.leverage, marginMode: profile.marginMode,
    },
  });
});

// Account: "vst" (demo) or "real". Switch only when stopped and flat.
router.post("/me/account", async (req, res) => {
  const row = await subscriberFor(req);
  if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
  const account = String(req.body?.account ?? "");
  if (account !== "vst" && account !== "real") return refuse(res, 422, "account", "Такого счёта нет");
  if (account === subscriberAccount(row)) return res.json({ account });
  // Open trades on the old account are not a blocker: the bot keeps managing
  // them there (stops, takes, CAB closes) until they are closed.
  if (row.trading_enabled) return refuse(res, 409, "trading_running", "Сначала нажмите «Стоп»");
  let realVerified = Boolean(row.real_key_verified_at);
  if (account === "real") {
    if (!row.real_allowed) return refuse(res, 403, "real_not_allowed", "Владелец не разрешил реальный счёт");
    if (req.body?.confirm !== true) return refuse(res, 422, "confirm", "Подтвердите торговлю на реальные деньги");
    // Without a key yet the account is just chosen; the key is checked on the
    // real account when it is saved, and "Старт" requires that check.
    if (row.api_key_encrypted && row.api_secret_encrypted) try {
      await realAccountBalance(decryptSecret(row.api_key_encrypted as string), decryptSecret(row.api_secret_encrypted as string));
      realVerified = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "BingX error";
      return refuse(res, 422, "real_key_rejected", `Реальный счёт BingX не принял ключ: ${message.slice(0, 200)}`);
    }
  }
  await pool.query(
    `UPDATE subscribers SET trading_account = $2,
       real_key_verified_at = CASE WHEN $3 THEN COALESCE(real_key_verified_at, now()) ELSE real_key_verified_at END,
       version = version + 1, updated_at = now() WHERE id = $1`,
    [row.id, account, realVerified]);
  notifyOwner(row, [`Счёт переключён: ${ACCOUNT_NAME(subscriberAccount(row))} → ${ACCOUNT_NAME(account)}.`,
    "Торговля начнётся после «Старт»."]);
  res.json({ account });
});

router.post("/me/trading", async (req, res) => {
  const row = await subscriberFor(req);
  const enable = req.body?.enabled === true;
  if (enable) {
    if (row.status !== "approved") return refuse(res, 403, "not_approved", "Заявка ещё не одобрена");
    if (!row.api_key_verified_at) return refuse(res, 422, "no_key", "Сначала добавьте и проверьте ключ BingX");
    if (!subscriberTradingStrategy(row)) {
      return refuse(res, 422, "no_strategy", "Выберите стратегию");
    }
    if (subscriberAccount(row) === "vst" && row.key_is_owner_main) {
      return refuse(res, 409, "same_as_owner_bot",
        "На демо-счёте этого ключа уже торгует основной бот. Выберите реальный счёт или ключ другого аккаунта BingX.");
    }
    if (subscriberAccount(row) === "real" && (!row.real_allowed || !row.real_key_verified_at)) {
      return refuse(res, 403, "real_not_ready", "Реальный счёт не разрешён владельцем или ключ не проверен на реальном счёте");
    }
    await pool.query(
      "UPDATE subscribers SET trading_enabled = true, trading_started_at = now(), updated_at = now() WHERE id = $1",
      [row.id],
    );
  } else {
    const account = subscriberAccount(row);
    // Announced here (always, at once); the worker sees this state and does not repeat it.
    await pool.query(
      `UPDATE subscribers SET trading_enabled = false, trading_stopped_at = now(), updated_at = now(),
         trading_notice = $2 WHERE id = $1`,
      [row.id, `${account}:off`],
    );
    if (row.trading_enabled) {
      const open = await openPositionsAnywhere(row.id);
      notifyOwner(row, [`BingX ${account === "real" ? "REAL" : "VST"} · Нажат «Стоп»: торговля на ${account === "real" ? "РЕАЛЬНОМ счёте" : "демо-счёте"} остановлена.`,
        open ? `Новые сделки не открываются; открытые (${open}) бот доведёт до закрытия.` : "Открытых сделок нет."]);
    }
  }
  res.json({ tradingEnabled: enable });
});

// ---------------- owner ----------------

// The owner's own strategy (owner 2026-10-28). Applies to the owner's bot's
// NEW entries within ~15 s; open positions keep the strategy they opened with.
router.get("/journal/trading-strategy", requireJournalSession, requireJournalOwner, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const current = await loadOwnerStrategy(pool);
  res.json({
    strategy: current.strategy, patternExit: current.patternExit ?? null,
    patterns: current.patterns ?? [], strategyText: describeTradingStrategy(current),
    updatedAt: current.updatedAt, choices: strategyChoices(),
  });
});

// Background PAPER per strategy (% to the deposit), same for owner and subscribers.
function daysQuery(req: Request): number | null {
  const days = Number(req.query.days);
  return [7, 30, 90].includes(days) ? days : null;
}
function patternsQuery(req: Request): string[] {
  const raw = typeof req.query.patterns === "string" ? req.query.patterns : "";
  return raw.split(",").map((p) => p.trim()).filter((p) => (TRADE_PATTERNS as string[]).includes(p)).slice(0, 3);
}
router.get("/journal/strategy-paper", requireJournalSession, requireJournalOwner, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(await loadStrategyPaper(pool, { patterns: patternsQuery(req), days: daysQuery(req) }));
});

router.post("/journal/trading-strategy", requireJournalSession, requireJournalOwner, async (req, res) => {
  const choice = strategyChoiceFrom(req.body);
  if ("error" in choice) return refuse(res, 422, choice.error, STRATEGY_ERRORS[choice.error] ?? "Неверная стратегия");
  const saved = await saveOwnerStrategy(pool, choice);
  res.json({ strategy: saved.strategy, patternExit: saved.patternExit ?? null,
    patterns: saved.patterns ?? [], strategyText: describeTradingStrategy(saved) });
});

// Owner: allow / forbid the REAL account for a person. Forbidding stops new
// entries at once; open REAL positions keep being managed until closed.
router.post("/journal/subscribers/:id/real", requireJournalSession, requireJournalOwner, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id)) return refuse(res, 422, "invalid_id", "Неверный подписчик");
  const allowed = req.body?.allowed === true;
  const result = await pool.query(
    `UPDATE subscribers SET real_allowed = $2,
       trading_enabled = CASE WHEN $2 = false AND trading_account = 'real' THEN false ELSE trading_enabled END,
       updated_at = now() WHERE id = $1 RETURNING *`,
    [id, allowed]);
  if (!result.rowCount) return refuse(res, 404, "not_found", "Подписчик не найден");
  notifyOwner(result.rows[0] as Row, [allowed ? "Владелец разрешил реальный счёт."
    : "Владелец закрыл реальный счёт: новые реальные сделки не открываются, открытые доводятся до закрытия."]);
  res.json({ subscriber: publicView(result.rows[0] as Row) });
});

router.get("/journal/subscribers", requireJournalSession, requireJournalOwner, async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { rows } = await pool.query("SELECT * FROM subscribers ORDER BY status = 'pending' DESC, requested_at DESC");
  const list = await Promise.all((rows as Row[]).map(async (row) => {
    let stats = { closed: 0, netUsdt: 0, openPositions: 0 };
    if (row.status === "approved") {
      try {
        const perf = await performance(row.id, subscriberAccount(row));
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
  notifyOwner(result.rows[0] as Row, [{ approve: "Заявка одобрена.", reject: "Заявка отклонена.",
    block: "Доступ заблокирован: торговля остановлена.", unblock: "Доступ снова открыт." }[decision as "approve"]]);
  res.json({ subscriber: publicView(result.rows[0] as Row) });
});

export default router;
