import { useEffect, useState } from "react";

export type StrategyChoices = {
  strategies: { id: string; label: string }[];
  exits: { id: string; label: string }[];
  patterns: { id: string; label: string }[];
};
export type StrategyValue = { strategy: string | null; patternExit: string | null; patterns: string[] };

export const STRATEGY_DESCRIPTIONS: Record<string, string> = {
  follow_cab: "Бот делает всё, как CAB: стоп, перенос стопа в безубыток, трейлинг и закрытие — по правилам CAB для каждого паттерна. Своих правил у бота нет.",
  take5: "Вся позиция закрывается, когда цена прошла +5% от входа. Стоп и закрытие до этого — как в CAB.",
  take8: "Вся позиция закрывается, когда цена прошла +8% от входа. Стоп и закрытие до этого — как в CAB.",
  take10: "Вся позиция закрывается, когда цена прошла +10% от входа. Стоп и закрытие до этого — как в CAB.",
  patterns: "Торгуются только выбранные паттерны (1, 2 или 3 из 4), выход — на выбор.",
};

/**
 * Strategy picker shared by the subscriber cabinet and the owner's VST page.
 * Strategies 1-4 save on click; "По паттернам" saves after choosing 1-3
 * patterns and an exit. BTC always follows CAB (shown as a note).
 */
export function StrategyPicker({ value, choices, disabled, pending, onSave }: {
  value: StrategyValue;
  choices: StrategyChoices;
  disabled?: boolean;
  pending?: boolean;
  onSave: (choice: { strategy: string; patternExit?: string; patterns?: string[] }) => void;
}) {
  const [draft, setDraft] = useState<string | null>(value.strategy);
  const [patterns, setPatterns] = useState<string[]>(value.patterns);
  const [exit, setExit] = useState<string | null>(value.patternExit);
  useEffect(() => {
    setDraft(value.strategy); setPatterns(value.patterns); setExit(value.patternExit);
  }, [value.strategy, value.patternExit, value.patterns.join(",")]);
  const lock = disabled || pending;
  const togglePattern = (id: string) =>
    setPatterns((list) => list.includes(id) ? list.filter((p) => p !== id)
      : list.length >= 3 ? list : [...list, id]);
  const patternsValid = patterns.length >= 1 && patterns.length <= 3 && Boolean(exit);
  const patternsChanged = value.strategy !== "patterns" || exit !== value.patternExit ||
    [...patterns].sort().join(",") !== [...value.patterns].sort().join(",");
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {choices.strategies.map((s, index) => {
          const saved = value.strategy === s.id;
          const active = draft === s.id;
          return (
            <button key={s.id} type="button" disabled={lock}
              onClick={() => { setDraft(s.id); if (s.id !== "patterns" && !saved) onSave({ strategy: s.id }); }}
              className={`border p-4 text-left transition-colors disabled:cursor-not-allowed ${
                active ? "border-primary bg-primary/10" : "border-border hover:border-primary/40"}`}>
              <span className="flex items-center justify-between gap-2">
                <span className="font-bold">{index + 1}. {s.label}</span>
                {saved && <span className="text-xs font-bold text-primary">выбрана</span>}
              </span>
              <span className="mt-2 block text-xs text-muted-foreground">{STRATEGY_DESCRIPTIONS[s.id]}</span>
            </button>
          );
        })}
      </div>
      {draft === "patterns" && (
        <div className="border border-border p-4 space-y-3" data-testid="strategy-patterns">
          <div>
            <p className="text-sm font-semibold">Паттерны (от 1 до 3)</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {choices.patterns.map((p) => {
                const on = patterns.includes(p.id);
                return (
                  <button key={p.id} type="button" disabled={lock || (!on && patterns.length >= 3)}
                    onClick={() => togglePattern(p.id)}
                    className={`border px-3 py-2 text-xs font-semibold disabled:opacity-50 ${
                      on ? "border-primary bg-primary/10 text-primary" : "border-border"}`}>
                    {on ? "✓ " : ""}{p.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <p className="text-sm font-semibold">Выход</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {choices.exits.map((e) => (
                <button key={e.id} type="button" disabled={lock} onClick={() => setExit(e.id)}
                  className={`border px-3 py-2 text-xs font-semibold ${
                    exit === e.id ? "border-primary bg-primary/10 text-primary" : "border-border"}`}>
                  {e.label}
                </button>
              ))}
            </div>
          </div>
          <button type="button" disabled={lock || !patternsValid || !patternsChanged}
            onClick={() => onSave({ strategy: "patterns", patternExit: exit!, patterns })}
            className="h-10 border border-primary bg-primary px-4 text-sm font-bold text-primary-foreground disabled:opacity-50">
            Сохранить
          </button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">BTC при любой стратегии торгуется по правилам CAB для BTC.</p>
    </div>
  );
}
