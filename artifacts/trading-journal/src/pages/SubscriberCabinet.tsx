import { useState, type ReactNode } from "react";
import { useClerk } from "@clerk/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, KeyRound, LogOut, Play, ShieldX, Square, Target } from "lucide-react";
import { BrandLockup } from "@/components/brand";
import { formatPercent, formatUsdt, inPeriod, summarize, toneClass, closeReasonGroup } from "@/lib/performance";
import {
  api, ApiFailure, runtimeText, STRATEGY_TEXT,
  type PerformanceTrade, type StrategyOption, type Subscription,
} from "@/lib/subscriber-api";

type SubscriptionResponse = { subscription: Subscription; strategies: StrategyOption[]; keysConfigured: boolean };

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
    mutationFn: () => api<{ verified: boolean; balanceVst: string | null }>("/me/api-key", { method: "POST", body: { apiKey, apiSecret } }),
    onSuccess: (data) => {
      setApiKey(""); setApiSecret(""); setEditing(false);
      setMessage(`Ключ проверен${data.balanceVst ? `, баланс демо-счёта VST: ${data.balanceVst}` : ""}`);
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
          <p className="text-sm">Ключ <b>••••{sub.apiKeyLast4}</b> проверен и сохранён в зашифрованном виде.</p>
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

function StrategyStep({ sub, strategies, onChanged }: { sub: Subscription; strategies: StrategyOption[]; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const choose = useMutation({
    mutationFn: (strategy: string) => api("/me/strategy", { method: "POST", body: { strategy } }),
    onSuccess: () => { setError(null); onChanged(); },
    onError: (e) => setError(e instanceof ApiFailure ? e.message : "Не удалось выбрать"),
  });
  return (
    <Step n={2} title="Стратегия" done={Boolean(sub.strategy)}>
      <div className="grid gap-3 sm:grid-cols-2">
        {strategies.map((strategy) => {
          const selected = sub.strategy === strategy.id;
          return (
            <button key={strategy.id} type="button" disabled={!strategy.available || sub.tradingEnabled || choose.isPending}
              onClick={() => choose.mutate(strategy.id)}
              className={`border p-4 text-left transition-colors disabled:cursor-not-allowed ${
                selected ? "border-primary bg-primary/10" : "border-border hover:border-primary/40"} ${!strategy.available ? "opacity-50" : ""}`}>
              <span className="flex items-center justify-between gap-2">
                <span className="font-bold">{strategy.label}</span>
                {selected ? <span className="text-xs font-bold text-primary">выбрана</span>
                  : !strategy.available ? <span className="text-xs text-muted-foreground">скоро</span> : null}
              </span>
              <span className="mt-2 block text-xs text-muted-foreground">{STRATEGY_TEXT[strategy.id]}</span>
            </button>
          );
        })}
      </div>
      {sub.tradingEnabled && <p className="mt-3 text-xs text-muted-foreground">Стратегию можно сменить после остановки торговли.</p>}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
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
    <Step n={3} title="Торговля" done={sub.tradingEnabled}>
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
        Торговля идёт на демо-счёте BingX VST. На каждую сделку бот берёт 1% баланса, плечо x10, изолированная маржа.
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

export default function SubscriberCabinet() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["me-subscription"],
    queryFn: () => api<SubscriptionResponse>("/me/subscription"),
    refetchInterval: 15_000,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["me-subscription"] });
  if (query.isLoading) return <Shell><div className="h-48 animate-pulse border border-border bg-card" /></Shell>;
  if (query.error || !query.data) {
    return <Shell><Notice icon={<ShieldX className="h-10 w-10 text-destructive" />} title="Не удалось загрузить" text="Обновите страницу чуть позже." /></Shell>;
  }
  const { subscription: sub, strategies, keysConfigured } = query.data;
  if (sub.status === "pending") {
    return <Shell><Notice icon={<Clock className="h-10 w-10 text-primary" />} title="Заявка отправлена"
      text="Владелец получит её и одобрит. Эта страница обновится сама, ничего нажимать не нужно." /></Shell>;
  }
  if (sub.status === "rejected" || sub.status === "blocked") {
    return <Shell><Notice icon={<ShieldX className="h-10 w-10 text-destructive" />}
      title={sub.status === "rejected" ? "Заявка отклонена" : "Доступ приостановлен"}
      text="Если это ошибка — напишите владельцу." /></Shell>;
  }
  return (
    <Shell>
      <div className="flex items-center gap-3">
        <Target className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-bold">Мой торговый бот</h1>
      </div>
      <KeyStep sub={sub} keysConfigured={keysConfigured} onChanged={refresh} />
      <StrategyStep sub={sub} strategies={strategies} onChanged={refresh} />
      <TradingStep sub={sub} onChanged={refresh} />
      <Results />
      <p className="flex items-center gap-2 text-xs text-muted-foreground"><KeyRound className="h-3.5 w-3.5" />Ключ хранится зашифрованным и никому не показывается, включая владельца.</p>
    </Shell>
  );
}
