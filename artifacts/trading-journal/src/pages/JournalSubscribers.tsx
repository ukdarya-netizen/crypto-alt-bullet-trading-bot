import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Pause, Play, ShieldOff, X } from "lucide-react";
import { formatUsdt, toneClass } from "@/lib/performance";
import { api, ApiFailure, positionSettingsText, runtimeText, type Subscription } from "@/lib/subscriber-api";

type Row = Subscription & { stats: { closed: number; netUsdt: number; openPositions: number } };

const STATUS: Record<Subscription["status"], { label: string; cls: string }> = {
  pending: { label: "Ждёт решения", cls: "border-amber-400/40 bg-amber-400/10 text-amber-300" },
  approved: { label: "Одобрен", cls: "border-success/40 bg-success/10 text-success" },
  rejected: { label: "Отклонён", cls: "border-border text-muted-foreground" },
  blocked: { label: "Заблокирован", cls: "border-destructive/40 bg-destructive/10 text-destructive" },
};


function date(value: string | null) {
  return value ? new Date(value).toLocaleString("ru-RU", { timeZone: "Europe/Samara", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
}

export default function JournalSubscribers() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["owner-subscribers"],
    queryFn: () => api<{ subscribers: Row[]; keysConfigured: boolean }>("/journal/subscribers"),
    refetchInterval: 15_000,
  });
  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: number; decision: string }) =>
      api(`/journal/subscribers/${id}/decision`, { method: "POST", body: { decision } }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ["owner-subscribers"] }),
  });
  const rows = query.data?.subscribers ?? [];
  const pending = rows.filter((row) => row.status === "pending");
  const others = rows.filter((row) => row.status !== "pending");

  const card = (row: Row) => {
    const state = runtimeText(row);
    return (
      <li key={row.id} className="border border-border bg-card p-4" data-testid={`subscriber-${row.id}`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate font-bold">{row.name || row.email || `Пользователь #${row.id}`}</p>
            <p className="truncate text-xs text-muted-foreground">{row.email ?? "email не указан"} · заявка {date(row.requestedAt)}</p>
          </div>
          <span className={`shrink-0 border px-2 py-0.5 text-[11px] font-bold uppercase ${STATUS[row.status].cls}`}>{STATUS[row.status].label}</span>
        </div>
        {row.status === "approved" && (
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
            <div><p className="text-[10px] uppercase text-muted-foreground">Ключ</p><p className={row.apiKeyVerifiedAt ? "text-success" : "text-muted-foreground"}>{row.apiKeyVerifiedAt ? `••••${row.apiKeyLast4}` : "нет"}</p></div>
            <div><p className="text-[10px] uppercase text-muted-foreground">Стратегия</p><p>{row.strategyText ?? "—"}</p><p className="text-[11px] text-muted-foreground">{positionSettingsText(row.positionSettings)}</p></div>
            <div><p className="text-[10px] uppercase text-muted-foreground">Торговля</p><p className="flex items-center gap-1">{row.tradingEnabled ? <><Play className="h-3 w-3 text-success" />вкл</> : <><Pause className="h-3 w-3" />выкл</>}</p></div>
            <div><p className="text-[10px] uppercase text-muted-foreground">Сделки</p><p>{row.stats.closed} закр. · {row.stats.openPositions} откр.</p></div>
            <div><p className="text-[10px] uppercase text-muted-foreground">Прибыль</p><p className={`font-bold tabular ${toneClass(row.stats.closed ? row.stats.netUsdt : null)}`}>{row.stats.closed ? formatUsdt(row.stats.netUsdt) : "—"}</p></div>
          </div>
        )}
        {row.status === "approved" && <p className="mt-2 text-xs text-muted-foreground">{state.text}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {row.status === "pending" && <>
            <button type="button" onClick={() => decide.mutate({ id: row.id, decision: "approve" })}
              className="flex h-10 items-center gap-2 bg-success px-4 text-sm font-bold text-success-foreground"><Check className="h-4 w-4" />Одобрить</button>
            <button type="button" onClick={() => decide.mutate({ id: row.id, decision: "reject" })}
              className="flex h-10 items-center gap-2 border border-border px-4 text-sm"><X className="h-4 w-4" />Отклонить</button>
          </>}
          {row.status === "approved" && (
            <button type="button" onClick={() => { if (window.confirm("Заблокировать? Торговля подписчика остановится сразу; открытые позиции останутся на его бирже со стоп-лоссом.")) decide.mutate({ id: row.id, decision: "block" }); }}
              className="flex h-9 items-center gap-2 border border-destructive/40 px-3 text-xs font-bold text-destructive"><ShieldOff className="h-3.5 w-3.5" />Заблокировать</button>
          )}
          {(row.status === "blocked" || row.status === "rejected") && (
            <button type="button" onClick={() => decide.mutate({ id: row.id, decision: "unblock" })}
              className="flex h-9 items-center gap-2 border border-border px-3 text-xs font-bold"><Check className="h-3.5 w-3.5" />Одобрить</button>
          )}
        </div>
      </li>
    );
  };

  return (
    <section className="page-frame mx-auto max-w-4xl space-y-5" data-testid="page-subscribers">
      <p className="text-sm text-muted-foreground">
        Любой, кто зарегистрировался, появляется здесь как заявка. После одобрения человек сам вводит ключ BingX,
        выбирает стратегию и нажимает «Старт». Торговля — только на демо-счёте BingX VST. Ключи хранятся зашифрованными, их не видно даже здесь.
      </p>
      {query.data && !query.data.keysConfigured && (
        <p className="border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-200">
          Не задан секрет SUBSCRIBER_KEYS_SECRET — подписчики не смогут сохранить ключи. Добавьте его в Secrets Replit (длинная случайная строка, 32+ символа).
        </p>
      )}
      {decide.error && <p className="text-sm text-destructive">{decide.error instanceof ApiFailure ? decide.error.message : "Ошибка"}</p>}
      {query.isLoading ? <div className="h-32 animate-pulse border border-border bg-card" /> : query.error ? (
        <p className="border border-destructive/40 bg-destructive/10 p-4 text-sm">Не удалось загрузить подписчиков.</p>
      ) : (
        <>
          <div>
            <h2 className="mb-2 text-sm font-bold">Новые заявки {pending.length > 0 && <span className="ml-1 bg-amber-400 px-1.5 text-xs text-black">{pending.length}</span>}</h2>
            {pending.length ? <ul className="space-y-2">{pending.map(card)}</ul> : <p className="text-sm text-muted-foreground">Новых заявок нет.</p>}
          </div>
          <div>
            <h2 className="mb-2 text-sm font-bold">Подписчики</h2>
            {others.length ? <ul className="space-y-2">{others.map(card)}</ul> : <p className="text-sm text-muted-foreground">Пока никого.</p>}
          </div>
        </>
      )}
    </section>
  );
}
