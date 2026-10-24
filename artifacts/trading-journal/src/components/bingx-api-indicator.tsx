import { useEffect, useState } from "react";
import {
  getGetJournalBingxConnectionQueryKey,
  useGetJournalBingxConnection,
} from "@workspace/api-client-react";

const FRESH_FOR_MS = 90_000;

export function BingxApiIndicator() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const connection = useGetJournalBingxConnection({
    query: {
      queryKey: getGetJournalBingxConnectionQueryKey(),
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
      refetchOnMount: "always",
      retry: false,
    },
  });

  const checkedAt = connection.data?.checkedAt
    ? Date.parse(connection.data.checkedAt)
    : NaN;
  const fresh = Number.isFinite(checkedAt) &&
    now - checkedAt >= -5_000 &&
    now - checkedAt <= FRESH_FOR_MS;
  const online = !connection.isError && connection.data?.status === "connected" && fresh;

  return (
    <section
      className="flex items-center justify-between gap-3 border border-border bg-card/60 px-4 py-3"
      aria-label="Подключение API BingX"
      data-testid="bingx-api-indicator"
    >
      <span className="text-xs font-bold uppercase tracking-wider">Подключение BingX</span>
      <div className="flex items-center gap-2" role="status" aria-live="polite">
        <span
          className={`h-2.5 w-2.5 shrink-0 rounded-full ${online ? "bg-success" : "bg-destructive"}`}
          aria-hidden="true"
        />
        <span className={`font-mono text-sm font-bold ${online ? "text-success" : "text-destructive"}`}>
          {online ? "ON" : "OFF"}
        </span>
      </div>
    </section>
  );
}