import { useState, type ReactNode } from "react";
import { useClerk } from "@clerk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, KeyRound, LogOut, Play, ShieldX, Square, Target } from "lucide-react";
import { BrandLockup } from "@/components/brand";
import { StrategyPicker, type StrategyChoices } from "@/components/strategy-picker";
import { StrategyPaperPanel } from "@/components/strategy-paper-panel";
import { formatPercent, formatUsdt, inPeriod, summarize, toneClass, closeReasonGroup } from "@/lib/performance";
import {
  api, ApiFailure, positionSettingsText, runtimeText,
  type PerformanceTrade, type PositionChoices, type PositionSettings, type Subscription,
} from "@/lib/subscriber-api";

type SubscriptionResponse = {
  subscription: Subscription; strategyChoices: StrategyChoices; keysConfigured: boolean; positionChoices: PositionChoices;
};

function Segmented<T extends string>({ value, options, onChange, disabled }: {
  value: T; options: { id: T; label: string }[]; onChange: (id: T) => void; disabled: boolean;
}) {
  return (
    <div className="grid grid-cols-2 border border-border">
      {options.map((option) => (
        <button key={option.id} type="button" disabled={disabled} onClick={() => onChange(option.id)}
          aria-pressed={value === option.id}
          className={`h-11 px-3 text-sm font-bold transition-colors disabled:cursor-not-allowed ${
            value === option.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Step({ n, title, done, children }: { n: number; title: string; done: boolean; children: ReactNode }) {
  return (
    <section className={`border bg-card p-5 ${done ? "border-success/40" : "border-border"}`}>
      <h2 className="mb-4 flex items-center gap-3 text-base font-bold">
        <span className={`grid h-7 w-7 shrink-0 place-items-center border text-xs ${done ? "border-success/50 bg-success/10 text-success" : "border-primary/40 text-primary"}`}>
          {done ? <CheckCircle2 className="h-4 w-4" /> : n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { signOut } = useClerk();
  return (
    <div className="min-h-[100dvh] bg-background">
      <header className="flex h-16 items-center justify-between border-b border-border bg-card px-4 md:px-8">
        <BrandLockup />
        <button type="button" onClick={() => signOut({ redirectUrl: "/" })}
          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <LogOut className="h-4 w-4" /> Выйти
        </button>
      </header>
      <main className="mx-auto max-w-3xl space-y-4 p-4 pb-16 md:p-8">{children}</main>
    </div>
  );
}

function Notice({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return (
    <div className="border border-border bg-card p-8 text-center">
      <div className="mx-auto mb-4 grid h-12 w-12 place-items-center">{icon}</div>
      <h1 className="text-xl font-bold">{title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function KeyStep({ sub, keysConfigured, onChanged }: { sub: Subscription; keysConfigured: boolean; onChanged: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [editing, setEditing] = useState(!sub.apiKeyVerifiedAt);
  const [message, setMessage] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => api<{ verified: boolean; balanceVst: string | null; balanceReal: string | null; realVerified: boolean }>("/me/api-key", { method: "POST", body: { apiKey, apiSecret } }),
    onSuccess: (data) => {
      setApiKey(""); setApiSecret(""); setEditing(false);
      setMessage(`Ключ проверен${data.balanceVst ? `, демо-счёт VST: ${data.balanceVst}` : ""}${
        data.realVerified ? `, реальный счёт: ${data.balanceReal ?? "—"} USDT` : ", реальный счёт ключ не принял"}`);
      onChanged();
    },
    onError: (error) => setMessage(error instanceof ApiFailure ? error.message : "Не удалось сохранить ключ"),
  });
  const remove = useMutation({
    mutationFn: () => api("/me/api-key", { method: "DELETE" }),
    onSuccess: () => { setEditing(true); setMessage("Ключ удалён, торговля остановлена"); onChanged(); },
  });
  return (
    <Step n={1} title="Ключ API BingX" done={Boolean(sub.apiKeyVerifiedAt) && !editing}>
      {!keysConfigured && <p className="mb-3 text-sm text-amber-300">Владелец ещё не включил хранилище ключей. Попробуйте позже.</p>}
      {sub.apiKeyVerifiedAt && !editing ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">Ключ <b>••••{sub.apiKeyLast4}</b> проверен и сохранён в зашифрованном виде.
            {sub.realKeyVerifiedAt ? " Реальный счёт: ключ подходит." : " Реальный счёт: ключ не проверен."}</p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setEditing(true)} className="border border-border px-3 py-2 text-xs font-bold hover:bg-muted">Заменить</button>
            <button type="button" onClick={() => remove.mutate()} className="border border-destructive/40 px-3 py-2 text-xs font-bold text-destructive hover:bg-destructive/10">Удалить</button>
          </div>
        </div>
      ) : (
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); setMessage(null); save.mutate(); }}>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
            <li>BingX → Профиль → Управление API → Создать API.</li>
            <li>Права: <b className="text-foreground">чтение</b> и <b className="text-foreground">торговля бессрочными фьючерсами</b>.</li>
            <li><b className="text-destructive">Вывод средств НЕ включайте.</b> Бот откажется торговать, если вывод разрешён.</li>
            <li>Скопируйте API Key и Secret Key сюда. Ключ хранится зашифрованным и больше нигде не показывается.</li>
          </ol>
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="API Key" autoComplete="off" spellCheck={false}
            className="h-11 w-full border border-input px-3 text-sm" />
          <input value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} placeholder="Secret Key" type="password" autoComplete="new-password"
            className="h-11 w-full border border-input px-3 text-sm" />
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={save.isPending || !apiKey || !apiSecret || !keysConfigured}
              className="h-11 bg-primary px-5 text-sm font-bold text-primary-foreground disabled:opacity-50">
              {save.isPending ? "Проверяю ключ…" : "Проверить и сохранить"}
            </button>
            {sub.apiKeyVerifiedAt && (
              <button type="button" onClick={() => setEditing(false)} className="h-11 border border-border px-4 text-sm">Отмена</button>
            )}
          </div>
        </form>
      )}
      {message && <p className="mt-3 text-sm text-muted-foreground">{message}</p>}
      {sub.apiKeyError && !sub.apiKeyVerifiedAt && <p className="mt-2 text-xs text-destructive">Последняя ошибка BingX: {sub.apiKeyError}</p>}
    </Step>
  );
}

function StrategyStep({ sub, choices, onChanged }: { sub: Subscription; choices: StrategyChoices; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const choose = useMutation({
    mutationFn: (choice: { strategy: string; patternExit?: string; patterns?: string[] }) =>
      api("/me/strategy", { method: "POST", body: choice }),
    onSuccess: () => { setError(null); onChanged(); },
    onError: (e) => setError(e instanceof ApiFailure ? e.message : "Не удалось выбрать"),
  });
  return (
    <Step n={2} title="Стратегия" done={Boolean(sub.strategyText)}>
      {sub.strategyText && <p className="mb-3 text-sm">Сейчас: <span className="font-semibold">{sub.strategyText}</span></p>}
      <StrategyPicker
        value={{ strategy: sub.strategy, patternExit: sub.patternExit, patterns: sub.patterns }}
        choices={choices} disabled={sub.tradingEnabled} pending={choose.isPending}
        onSave={(choice) => choose.mutate(choice)} />
      {sub.tradingEnabled && <p className="mt-3 text-xs text-muted-foreground">Стратегию можно сменить после остановки торговли.</p>}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-4 border-t border-border pt-3">
        <StrategyPaperPanel endpoint="/me/strategy-paper"
          patterns={sub.strategy === "patterns" ? sub.patterns : []} />
      </div>
    </Step>
  );
}

function SizeStep({ sub, choices, onChanged }: { sub: Subscription; choices: PositionChoices; onChanged: () => void }) {
  const saved = sub.positionSettings;
  const [mode, setMode] = useState<PositionSettings["allocationMode"]>(saved.allocationMode);
  const [value, setValue] = useState(String(saved.allocationValue));
  const [leverage, setLeverage] = useState(saved.leverage);
  const [margin, setMargin] = useState<PositionSettings["marginMode"]>(saved.marginMode);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const limits = choices.allocation[mode];
  const numeric = Number(value.replace(",", "."));
  const valid = Number.isFinite(numeric) && numeric >= limits.min && numeric <= limits.max;
  const changed = mode !== saved.allocationMode || numeric !== saved.allocationValue ||
    leverage !== saved.leverage || margin !== saved.marginMode;
  const locked = sub.tradingEnabled;
  const save = useMutation({
    mutationFn: () => api("/me/position-settings", {
      method: "POST", body: { allocationMode: mode, allocationValue: numeric, leverage, marginMode: margin },
    }),
    onSuccess: () => { setMessage({ text: "Сохранено", bad: false }); onChanged(); },
    onError: (e) => setMessage({ text: e instanceof ApiFailure ? e.message : "Не удалось сохранить", bad: true }),
  });
  const unit = sub.tradingAccount === "real" ? "USDT" : "VST";
  const example = valid
    ? mode === "percent"
      ? `При балансе 10 000 ${unit}: в сделку ${(10_000 * numeric / 100).toLocaleString("ru-RU")} ${unit} своих, позиция ${(10_000 * numeric / 100 * leverage).toLocaleString("ru-RU")} ${unit}.`
      : `В сделку ${numeric.toLocaleString("ru-RU")} ${unit} своих, позиция ${(numeric * leverage).toLocaleString("ru-RU")} ${unit}.`
    : mode === "percent" ? `Процент от ${limits.min} до ${limits.max}.` : `Сумма от ${limits.min} ${unit}.`;
  return (
    <Step n={3} title="Размер сделки" done={!changed}>
      <div className="space-y-5">
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase text-muted-foreground">Сколько своих денег в одну сделку</p>
          <Segmented value={mode} disabled={locked} onChange={(next) => { setMode(next); setValue(next === "percent" ? "1" : "10"); }}
            options={[{ id: "percent", label: "Процент от баланса" }, { id: "amount", label: "Сумма" }]} />
          <div className="flex items-center gap-2">
            <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" disabled={locked}
              className={`h-11 w-32 border px-3 text-sm tabular ${valid ? "border-input" : "border-destructive"}`} />
            <span className="text-sm text-muted-foreground">{mode === "percent" ? "% от баланса" : unit}</span>
          </div>
          <p className={`text-xs ${valid ? "text-muted-foreground" : "text-destructive"}`}>{example}</p>
        </div>
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase text-muted-foreground">Плечо</p>
          <div className="flex flex-wrap gap-2">
            {choices.leverage.map((option) => (
              <button key={option} type="button" disabled={locked} onClick={() => setLeverage(option)}
                aria-pressed={leverage === option}
                className={`h-10 min-w-12 border px-3 text-sm font-bold disabled:cursor-not-allowed ${
                  leverage === option ? "border-primary bg-primary text-primary-foreground" : "border-border hover:border-primary/40"}`}>
                {option}x
              </button>
            ))}
          </div>
          {leverage > 10 && <p className="text-xs text-amber-300">Чем выше плечо, тем ближе ликвидация к цене входа.</p>}
        </div>
        <div className="space-y-2">
          <p className="text-xs font-bold uppercase text-muted-foreground">Маржа</p>
          <Segmented value={margin} disabled={locked} onChange={(next) => {
            if (next === "ISOLATED" || next === "CROSSED") setMargin(next);
          }}
            options={[{ id: "ISOLATED", label: "Изолированная" }, { id: "CROSSED", label: "Кросс" }]} />
          <p className="text-xs text-muted-foreground">
            {margin === "ISOLATED"
              ? "Каждая сделка рискует только своей маржой. Если стоп далеко, бот сам довносит маржу, чтобы ликвидация была ниже стопа."
              : "Сделку держит весь баланс счёта: ликвидация дальше, но при сильном движении против рискует весь счёт. Защищает стоп-лосс из сигнала."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => { setMessage(null); save.mutate(); }}
            disabled={locked || !valid || !changed || save.isPending}
            className="h-11 bg-primary px-5 text-sm font-bold text-primary-foreground disabled:opacity-40">
            {save.isPending ? "Сохраняю…" : "Сохранить"}
          </button>
          <span className="text-xs text-muted-foreground">Сейчас: {positionSettingsText(saved, sub.tradingAccount)}</span>
        </div>
        {locked && <p className="text-xs text-muted-foreground">Менять можно после «Стоп» и закрытия открытых сделок.</p>}
        {message && <p className={`text-sm ${message.bad ? "text-destructive" : "text-success"}`}>{message.text}</p>}
      </div>
    </Step>
  );
}

function AccountStep({ sub, onChanged }: { sub: Subscription; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: (account: "vst" | "real") => api("/me/account", { method: "POST", body: { account, confirm } }),
    onSuccess: () => { setError(null); setConfirm(false); onChanged(); },
    onError: (e) => setError(e instanceof ApiFailure ? e.message : "Не удалось"),
  });
  const real = sub.tradingAccount === "real";
  return (
    <Step n={4} title="Счёт" done>
      <div className="grid grid-cols-2 border border-border">
        <button type="button" disabled={sub.tradingEnabled || change.isPending || !real}
          onClick={() => change.mutate("vst")} aria-pressed={!real}
          className={`h-11 px-3 text-sm font-bold disabled:cursor-not-allowed ${!real ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}>
          Демо VST
        </button>
        <button type="button" disabled={sub.tradingEnabled || change.isPending || real || !sub.realAllowed || !confirm}
          onClick={() => change.mutate("real")} aria-pressed={real}
          className={`h-11 px-3 text-sm font-bold disabled:cursor-not-allowed ${real ? "bg-destructive text-destructive-foreground" : "text-muted-foreground hover:bg-muted"}`}>
          Реальный счёт
        </button>
      </div>
      {real ? (
        <p className="mt-3 text-sm font-semibold text-destructive">Торговля на реальном счёте BingX — реальные деньги (USDT).</p>
      ) : sub.realAllowed ? (
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} disabled={sub.tradingEnabled}
            className="mt-0.5 h-4 w-4" />
          <span>Понимаю: на реальном счёте бот торгует реальными деньгами по тем же правилам, что на демо.</span>
        </label>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">Реальный счёт открывает владелец.</p>
      )}
      {sub.tradingEnabled && <p className="mt-2 text-xs text-muted-foreground">Счёт можно сменить после «Стоп» и закрытия открытых сделок.</p>}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </Step>
  );
}

function TradingStep({ sub, onChanged }: { sub: Subscription; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api("/me/trading", { method: "POST", body: { enabled } }),
    onSuccess: () => { setError(null); onChanged(); },
    onError: (e) => setError(e instanceof ApiFailure ? e.message : "Не удалось"),
  });
  const state = runtimeText(sub);
  const ready = Boolean(sub.apiKeyVerifiedAt && sub.strategy);
  const dot = { ok: "bg-success", wait: "bg-amber-400", bad: "bg-destructive", off: "bg-muted-foreground" }[state.tone];
  return (
    <Step n={5} title="Торговля" done={sub.tradingEnabled}>
      <p className="mb-4 flex items-start gap-2 text-sm"><span className={`mt-1.5 h-2 w-2 shrink-0 ${dot}`} />{state.text}</p>
      {sub.tradingEnabled ? (
        <button type="button" onClick={() => toggle.mutate(false)} disabled={toggle.isPending}
          className="flex h-12 w-full items-center justify-center gap-2 border border-destructive/50 bg-destructive/10 text-sm font-bold text-destructive sm:w-auto sm:px-8">
          <Square className="h-4 w-4" /> Стоп
        </button>
      ) : (
        <button type="button" onClick={() => toggle.mutate(true)} disabled={!ready || toggle.isPending}
          className="flex h-12 w-full items-center justify-center gap-2 bg-success text-sm font-bold text-success-foreground disabled:opacity-40 sm:w-auto sm:px-8">
          <Play className="h-4 w-4" /> Старт
        </button>
      )}
      {!ready && !sub.tradingEnabled && <p className="mt-3 text-xs text-muted-foreground">Сначала шаги 1 и 2.</p>}
      <p className="mt-4 text-xs text-muted-foreground">
        {sub.tradingAccount === "real"
          ? <b className="text-destructive">Торговля идёт на РЕАЛЬНОМ счёте BingX. </b>
          : "Торговля идёт на демо-счёте BingX VST. "}
        Размер сделки: {positionSettingsText(sub.positionSettings, sub.tradingAccount)}.
        «Стоп» сразу прекращает новые входы; уже открытые сделки бот доводит до закрытия.
      </p>
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
    </Step>
  );
}

function Results() {
  const performance = useQuery({
    queryKey: ["me-performance"],
    queryFn: () => api<{ trades: PerformanceTrade[]; openPositions: number }>("/me/performance"),
    refetchInterval: 30_000,
  });
  const trades = inPeriod((performance.data?.trades ?? []).map((t) => ({ ...t, id: t.sourceSignalId })), "30d", Date.now());
  const s = summarize(trades);
  return (
    <section className="border border-border bg-card p-5">
      <h2 className="mb-4 text-base font-bold">Мои результаты за 30 дней</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div><p className="text-[11px] uppercase text-muted-foreground">Прибыль</p><p className={`mt-1 text-2xl font-bold tabular ${toneClass(s.counted ? s.netUsdt : null)}`}>{s.counted ? formatUsdt(s.netUsdt) : "—"}</p></div>
        <div><p className="text-[11px] uppercase text-muted-foreground">Винрейт</p><p className="mt-1 text-2xl font-bold tabular">{formatPercent(s.winRate, 0, false)}</p></div>
        <div><p className="text-[11px] uppercase text-muted-foreground">Закрыто</p><p className="mt-1 text-2xl font-bold tabular">{s.trades}</p></div>
        <div><p className="text-[11px] uppercase text-muted-foreground">Открыто</p><p className="mt-1 text-2xl font-bold tabular">{performance.data?.openPositions ?? "—"}</p></div>
      </div>
      {trades.length > 0 && (
        <ul className="mt-4 border border-border">
          {[...trades].sort((a, b) => Date.parse(b.closedAt) - Date.parse(a.closedAt)).slice(0, 8).map((t) => (
            <li key={t.id} className="flex justify-between gap-3 border-t border-border/70 px-3 py-2 text-sm first:border-t-0">
              <span className="truncate"><b>{t.symbol}</b> <span className="text-muted-foreground">· {closeReasonGroup(t.closeReason).label}</span></span>
              <span className={`font-bold tabular ${toneClass(t.pnlUsdt)}`}>{formatUsdt(t.pnlUsdt)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The cabinet itself (key, strategy, size, start/stop, results). `embedded`
 * renders it inside the owner's journal ("Мой кабинет") without the
 * subscriber page shell; the owner is approved automatically by the API.
 */
export function SubscriberCabinetBody({ embedded = false }: { embedded?: boolean }) {
  const Wrap = embedded ? EmbeddedShell : Shell;
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["me-subscription"],
    queryFn: () => api<SubscriptionResponse>("/me/subscription"),
    refetchInterval: 15_000,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["me-subscription"] });
  if (query.isLoading) return <Wrap><div className="h-48 animate-pulse border border-border bg-card" /></Wrap>;
  if (query.error || !query.data) {
    return <Wrap><Notice icon={<ShieldX className="h-10 w-10 text-destructive" />} title="Не удалось загрузить" text="Обновите страницу чуть позже." /></Wrap>;
  }
  const { subscription: sub, strategyChoices, keysConfigured, positionChoices } = query.data;
  if (sub.status === "pending") {
    return <Wrap><Notice icon={<Clock className="h-10 w-10 text-primary" />} title="Заявка отправлена"
      text="Владелец получит её и одобрит. Эта страница обновится сама, ничего нажимать не нужно." /></Wrap>;
  }
  if (sub.status === "rejected" || sub.status === "blocked") {
    return <Wrap><Notice icon={<ShieldX className="h-10 w-10 text-destructive" />}
      title={sub.status === "rejected" ? "Заявка отклонена" : "Доступ приостановлен"}
      text="Если это ошибка — напишите владельцу." /></Wrap>;
  }
  return (
    <Wrap>
      {embedded ? (
        <p className="border border-primary/30 bg-primary/5 p-4 text-sm">
          Это та же страница, что видят подписчики. Здесь отдельный бот, не связанный с основным
          (VST · бот) и его стратегией. Счёт — демо VST или реальный. Ключ основного бота подходит
          только для реального счёта: на его демо-счёте уже торгует основной бот.
        </p>
      ) : (
        <div className="flex items-center gap-3">
          <Target className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold">Мой торговый бот</h1>
        </div>
      )}
      <KeyStep sub={sub} keysConfigured={keysConfigured} onChanged={refresh} />
      <StrategyStep sub={sub} choices={strategyChoices} onChanged={refresh} />
      <SizeStep key={JSON.stringify(sub.positionSettings)} sub={sub} choices={positionChoices} onChanged={refresh} />
      <AccountStep sub={sub} onChanged={refresh} />
      <TradingStep sub={sub} onChanged={refresh} />
      <Results />
      <p className="flex items-center gap-2 text-xs text-muted-foreground"><KeyRound className="h-3.5 w-3.5" />Ключ хранится зашифрованным и никому не показывается, включая владельца.</p>
    </Wrap>
  );
}

function EmbeddedShell({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-3xl space-y-4 pb-16">{children}</div>;
}

export default function SubscriberCabinet() {
  return <SubscriberCabinetBody />;
}
