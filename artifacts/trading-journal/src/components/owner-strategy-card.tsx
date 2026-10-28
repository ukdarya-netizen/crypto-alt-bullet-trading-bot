import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Target } from "lucide-react";
import { api, ApiFailure } from "@/lib/subscriber-api";
import { StrategyPicker, type StrategyChoices } from "@/components/strategy-picker";
import { StrategyPaperPanel } from "@/components/strategy-paper-panel";

type OwnerStrategy = {
  strategy: string; patternExit: string | null; patterns: string[]; strategyText: string;
  updatedAt: string | null; choices: StrategyChoices;
};

/** The owner's own bot strategy (applies to new entries within ~15 s). */
export function OwnerStrategyCard() {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  const query = useQuery({
    queryKey: ["owner-trading-strategy"],
    queryFn: () => api<OwnerStrategy>("/journal/trading-strategy"),
  });
  const save = useMutation({
    mutationFn: (choice: { strategy: string; patternExit?: string; patterns?: string[] }) =>
      api<{ strategyText: string }>("/journal/trading-strategy", { method: "POST", body: choice }),
    onSuccess: (data) => {
      setMessage({ text: `Сохранено: ${data.strategyText}. Действует для новых сделок; открытые закрываются по своей стратегии.`, bad: false });
      void queryClient.invalidateQueries({ queryKey: ["owner-trading-strategy"] });
    },
    onError: (e) => setMessage({ text: e instanceof ApiFailure ? e.message : "Не удалось сохранить", bad: true }),
  });
  if (!query.data) {
    return <div className="border border-border bg-card p-4 text-sm text-muted-foreground" data-testid="owner-strategy">
      {query.error ? "Стратегию загрузить не удалось" : "Загрузка стратегии…"}
    </div>;
  }
  const d = query.data;
  return (
    <section className="border border-border bg-card p-4 space-y-3" data-testid="owner-strategy">
      <div className="flex items-center gap-2">
        <Target className="h-4 w-4 text-primary" />
        <h2 className="font-bold">Стратегия моего бота</h2>
      </div>
      <p className="text-sm">Сейчас: <span className="font-semibold">{d.strategyText}</span></p>
      <StrategyPicker value={{ strategy: d.strategy, patternExit: d.patternExit, patterns: d.patterns }}
        choices={d.choices} pending={save.isPending} onSave={(choice) => save.mutate(choice)} />
      {message && <p className={`text-sm ${message.bad ? "text-destructive" : "text-muted-foreground"}`}>{message.text}</p>}
      <div className="border-t border-border pt-3">
        <StrategyPaperPanel endpoint="/journal/strategy-paper"
          patterns={d.strategy === "patterns" ? d.patterns : []} />
      </div>
    </section>
  );
}
