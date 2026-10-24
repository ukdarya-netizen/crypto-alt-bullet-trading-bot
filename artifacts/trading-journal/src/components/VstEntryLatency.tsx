import React, { useState } from "react";
import type { JournalVstEntryLatency } from "@workspace/api-client-react";
import { formatDate } from "@/lib/utils";

const labels = {
  measured: "Новые замеры после исправления",
  historical: "Исторические попытки без новой разбивки",
  not_attempted: "Без попытки рыночного входа",
};
function elapsed(value: number | null) {
  if (value === null) return "Неизвестно";
  return value < 1000 ? `${Math.round(value)} мс` : `${(value / 1000).toFixed(1)} с`;
}
export function VstEntryLatency({ data }: { data: JournalVstEntryLatency }) {
  const [cohort, setCohort] = useState<keyof typeof labels>("measured");
  const entries = data.entries.filter((e) => e.cohort === cohort);
  return (
    <div className="border-t border-border px-4 py-4 sm:px-5" data-testid="vst-entry-latency">
      <h3 className="text-sm font-bold uppercase">Сколько ждём отправки входа · 7 дней</h3>
      <p className="mt-2 text-xs text-muted-foreground">
        От получения сигнала до начала отправки заявки, не до исполнения на бирже.
        p50 — половина измеренных отправок быстрее; p95 — 95% быстрее.
      </p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {data.cohorts.map((c) => (
          <div key={c.cohort} className="border border-border p-3" data-testid={`latency-summary-${c.cohort}`}>
            <p className="text-xs font-semibold">{labels[c.cohort]} · {c.count}</p>
            <p className="mt-2 font-mono text-sm">p50 {elapsed(c.p50Ms)} · p95 {elapsed(c.p95Ms)}</p>
            <p className="mt-1 text-xs text-muted-foreground">Есть время отправки: {c.timedCount} из {c.count}</p>
            <p className="mt-2 text-xs">
              Отказы из-за свежести: {c.freshnessRefusals} из {c.refusals} подтверждённых отказов до отправки
              {c.freshnessRefusalPercent === null ? " · доля неизвестна" : ` · ${c.freshnessRefusalPercent.toFixed(1)}%`}.
            </p>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Отсутствующие замеры — «Неизвестно», не ноль. Маржа и плечо: от записи намерения до подтверждения,
        включая сверку. Проверки: нативная подготовка входа, включая свежий расчёт;
        финальная цена — последний запрос котировки. Ожидание отправки — после проверок.
        Этапы не складываются в полное время: между ними также есть ожидание обработки.
        В долю входят только доказанные истечения; старый код «котировка недоступна или устарела» не доказывает истечение.
      </p>
      {data.hasMore && <p className="mt-2 text-xs font-semibold">
        Статистика только по последним {data.entries.length} из {data.total} сигналов за 7 дней.
      </p>}
      <label className="mt-4 block text-xs font-semibold">
        Показать попытки
        <select className="ml-2 max-w-full border border-border bg-background p-2 text-xs" value={cohort}
          onChange={(e) => setCohort(e.target.value as keyof typeof labels)}>
          {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      {!entries.length ? <p className="mt-3 text-sm">Пока нет попыток этой группы.</p> :
        <div className="mt-3 max-h-96 overflow-auto">
          {entries.map((e) => (
            <details key={e.sourceSignalId} className="border-t border-border py-3">
              <summary className="cursor-pointer text-xs">
                <span className="font-bold">{e.symbol ?? "Неизвестно"}</span> · {e.sourceSignalId}
                {" · "}{e.transportAt ? `до отправки ${elapsed(e.receiptToTransportMs)}` :
                  e.refusedBeforeTransport ? "Отказ до отправки" : "Отправка не подтверждена"}
                {e.freshnessRefusal ? " · истекла свежесть" : ""}
              </summary>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                <div><dt className="text-muted-foreground">Получен</dt>
                  <dd>{e.receivedAt ? formatDate(e.receivedAt) : "Неизвестно"}</dd></div>
                <div><dt className="text-muted-foreground">Начата отправка</dt>
                  <dd>{e.transportAt ? formatDate(e.transportAt) : "Неизвестно"}</dd></div>
                {([
                  ["До нативной подготовки", e.receiptToNativeAttemptMs],
                  ["Изолированная маржа", e.marginModeMs], ["Плечо 10×", e.leverageMs],
                  ["Проверки и расчёт", e.nativeChecksMs], ["Финальная цена", e.finalPriceMs],
                  ["Ожидание отправки", e.pacingMs],
                ] as const).map(([label, value]) => <div key={label}>
                  <dt className="text-muted-foreground">{label}</dt><dd className="mt-1 font-mono">{elapsed(value)}</dd>
                </div>)}
              </dl>
            </details>
          ))}
        </div>}
    </div>
  );
}
