import "./_group.css";
import { Activity, CheckCircle2, History, LayoutDashboard, List, LogOut, Target, Terminal, Wallet } from "lucide-react";

type Signal = { id: string; symbol: string; source: string; pattern: string; status: string; detail?: string };

const signals: Signal[] = [
  { id: "sig_2025_02_14_001", symbol: "BTCUSDT", source: "bullet-webhook-8f3a", pattern: "impulse_buy", status: "В очереди" },
  { id: "sig_2025_02_13_017", symbol: "ETHUSDT", source: "bullet-webhook-1c92", pattern: "liquidation_cascade", status: "Бумажный ордер создан" },
  { id: "sig_2025_02_12_009", symbol: "SOLUSDT", source: "manual-review", pattern: "impulse_buy", status: "Не открыта · недостаточно средств", detail: "Недостаточно средств для открытия позиции" },
];

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`border bg-card ${className}`}>{children}</div>;
}

function Metric({ title, value, icon, color = "", subtitle }: { title: string; value: string; icon: React.ReactNode; color?: string; subtitle?: string }) {
  return <Card>
    <div className="flex items-center justify-between px-5 pt-4 text-xs font-medium uppercase tracking-wider text-muted-foreground">{title}{icon}</div>
    <div className={`px-5 pb-4 pt-2 font-mono text-2xl font-bold ${color}`}>{value}</div>
    {subtitle && <div className="px-5 pb-4 text-xs uppercase tracking-wider text-muted-foreground">{subtitle}</div>}
  </Card>;
}

function BulletPaperBot() {
  return <section className="space-y-4">
    <div className="flex flex-wrap items-start justify-between gap-3 border-b pb-3">
      <div>
        <h2 className="text-lg font-bold uppercase tracking-wide">Активный PAPER-бот Bullet</h2>
        <p className="mt-1 text-xs text-muted-foreground">Источник bullet-paper-store · только симуляция · обновление каждые 15 секунд</p>
        <p className="mt-1 text-xs text-muted-foreground">Приватный API BingX (mainnet, только проверка): подключён · чтение доступно. Ключи не используются для PAPER-ордера.</p>
        <div className="mt-3 border-l-2 border-amber-500/60 pl-3 text-xs text-muted-foreground">
          <p className="font-semibold text-foreground">Подготовка реальной торговли · запуск заблокирован</p>
          <p className="mt-1">Это только чтение состояния BingX; ордера и настройки биржи не изменяются.</p>
           <p className="mt-1">Проверки счёта в макете не выполняются; реальное исполнение заблокировано.</p>
        </div>
      </div>
      <span className="border border-primary/40 bg-primary/10 px-2 py-1 font-mono text-xs font-bold uppercase text-primary">PAPER · ACTIVE</span>
    </div>
    <Card className="border-primary/40">
      <div className="flex items-center gap-2 px-5 pt-4 text-xs font-medium uppercase tracking-wider text-muted-foreground"><Wallet className="h-4 w-4 text-primary" />Кошелёк активного бота · USDT</div>
      <div className="grid grid-cols-2 gap-4 px-5 py-4 sm:grid-cols-4">
        {["Начальный|100.00", "Свободно|73.40", "Зарезервировано|26.60", "Реализованный PnL|+4.82"].map((item) => { const [label, value] = item.split("|"); return <div key={label}><p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-1 font-mono text-lg font-semibold">{value} USDT</p></div>; })}
      </div>
    </Card>
    <Card>
      <div className="flex items-center gap-2 border-b px-5 py-4 text-sm font-bold uppercase tracking-wider"><Activity className="h-4 w-4 text-primary" />Последние сигналы бота <span className="font-mono text-xs font-normal text-muted-foreground">(3)</span></div>
      <div className="divide-y">{signals.slice(0, 2).map((signal) => <div key={signal.id} className="flex flex-wrap items-start justify-between gap-3 p-4"><div><p className="font-mono text-sm font-semibold">{signal.id}</p><p className="mt-1 text-xs text-muted-foreground">Получен: 14.02.2025 10:42 · Обновлён: 14.02.2025 10:42</p></div><span className="border bg-secondary px-2 py-1 text-xs">{signal.status}</span></div>)}</div>
    </Card>
    <Card>
      <div className="border-b px-5 py-4 text-sm font-bold uppercase tracking-wider">Открытые позиции активного PAPER-бота <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">(1)</span></div>
       <div className="grid gap-3 p-4 sm:grid-cols-4"><div><p className="font-mono text-sm font-bold">ETHUSDT</p><p className="mt-1 text-[10px] text-muted-foreground">sig_2025_02_13_017</p></div><div><p className="text-[10px] uppercase text-muted-foreground">Количество / остаток</p><p className="mt-1 font-mono text-sm">0.018 / 0.018</p></div><div><p className="text-[10px] uppercase text-muted-foreground">Вход / стоп</p><p className="mt-1 font-mono text-sm">2,712.40 / 2,658.10</p></div><div className="text-xs text-muted-foreground"><p>liquidation_cascade · open</p><p className="mt-1">Вход: 13.02.2025 18:20</p></div></div>
      <div className="border-t px-5 py-3 text-xs text-muted-foreground">Данные этого активного бота из отдельного PAPER-хранилища. Это не биржевой баланс и не legacy-записи журнала.</div>
    </Card>
  </section>;
}

function Deposit() {
  return <Card className="border-primary/40"><div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
    <div className="flex items-start gap-3"><div className="border border-primary/30 bg-primary/10 p-2 text-primary"><Wallet className="h-5 w-5" /></div><div><h2 className="text-sm font-semibold uppercase tracking-wider">Legacy-журнал · депозит симулятора</h2><p className="mt-1 text-xs text-muted-foreground">Начальный депозит: $100.00 USD</p></div></div>
    <div className="sm:text-right"><p className="text-xs uppercase tracking-wider text-muted-foreground">Расчётный баланс</p><p className="mt-1 font-mono text-3xl font-bold">$116.40</p><p className="mt-2 text-xs text-muted-foreground">Занято открытыми: $26.60 · Свободно: $89.80</p></div>
    <p className="text-xs text-muted-foreground sm:max-w-48">Прежний бумажный учёт записанных сделок, не кошелёк активного Bullet PAPER-бота. Валовой результат без комиссий и открытого PnL.</p>
  </div></Card>;
}

function Inbox() {
  return <section className="border bg-card"><div className="border-b p-4 sm:p-5"><h2 className="text-lg font-bold">Полученные и неоткрытые сигналы</h2><p className="mt-1 text-sm text-muted-foreground">При нехватке средств сигнал сохраняется как неоткрытый. После закрытия позиции старые сигналы не исполняются повторно.</p></div><div className="divide-y">{signals.map((signal) => <div key={signal.id} className="flex flex-wrap items-start justify-between gap-2 p-4 sm:px-5"><div><div className="font-semibold">{signal.symbol}</div><div className="text-xs text-muted-foreground">{signal.source} · 14.02.2025 10:42</div><div className="mt-1 text-xs text-muted-foreground">{signal.pattern.replaceAll("_", " ")} · цена сигнала 67,420.0000</div>{signal.detail && <p className="mt-2 text-xs text-muted-foreground">{signal.detail}</p>}</div><span className="border bg-secondary px-2 py-1 text-xs font-medium">{signal.status}</span></div>)}</div><div className="flex items-center justify-between border-t p-4 text-xs"><button type="button" className="opacity-40">Новые</button><span>Страница 1</span><button type="button" className="hover:underline">Ранее</button></div></section>;
}

export function Current() {
  return <div className="crypto-alt-journal min-h-screen">
    <div className="border-b border-primary/40 bg-primary/10 px-4 py-2 text-center font-mono text-xs uppercase tracking-wider text-foreground">Визуальный макет · данные примера, не состояние счёта</div>
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="hidden w-64 shrink-0 flex-col border-r bg-card md:flex"><div className="flex items-center gap-3 border-b p-6"><div className="h-6 w-6 bg-primary" /><span className="font-bold text-sm uppercase tracking-tight">CAB Journal</span></div><nav className="flex-1 space-y-1 p-4"><div className="flex items-center gap-3 bg-primary px-3 py-2 text-sm font-medium uppercase tracking-wider text-primary-foreground"><LayoutDashboard className="h-4 w-4" />Сводка</div><div className="flex items-center gap-3 px-3 py-2 text-sm font-medium uppercase tracking-wider"><List className="h-4 w-4" />Открытые позиции</div><div className="flex items-center gap-3 px-3 py-2 text-sm font-medium uppercase tracking-wider"><History className="h-4 w-4" />История сделок</div></nav><div className="space-y-4 border-t p-4"><div className="truncate px-2 font-mono text-xs text-muted-foreground">owner@cab-trading.dev</div><div className="flex items-center gap-3 px-3 py-2 text-sm uppercase tracking-wider text-muted-foreground"><LogOut className="h-4 w-4" />Выйти</div></div></aside>
      <main className="min-w-0 flex-1"><header className="flex h-14 items-center justify-between border-b bg-card px-4 md:hidden"><span className="font-bold text-sm uppercase">Торговый дневник</span><span className="text-sm text-muted-foreground">Выйти</span></header><div className="space-y-8 overflow-y-auto p-4 pb-24 md:p-8"><div className="mx-auto max-w-6xl"><div className="flex items-center justify-between border-b pb-4"><h1 className="flex items-center gap-3 text-2xl font-bold uppercase tracking-tight"><LayoutDashboard className="h-6 w-6 text-primary" />Сводка портфеля</h1><div className="border px-3 py-1 font-mono text-xs uppercase text-muted-foreground">Источник: journal</div></div><div className="mt-8"><BulletPaperBot /></div><div className="mt-8 border-l-2 pl-4"><h2 className="text-sm font-bold uppercase tracking-wider">Legacy-журнал · исторические записи</h2><p className="mt-1 text-xs text-muted-foreground">Следующие суммы и сделки — прежний учёт по записанным ордерам, отдельно от активного PAPER-бота Bullet.</p></div><div className="mt-4 space-y-4"><Deposit /><Inbox /></div><div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4"><Metric title="Реализованный PnL" value="$16.40" color="text-success" icon={<CheckCircle2 className="h-4 w-4" />} /><Metric title="Нереализованный PnL" value="+$2.84" color="text-success" icon={<Activity className="h-4 w-4" />} /><Metric title="Открытые сделки" value="1" icon={<Target className="h-4 w-4" />} /><Metric title="Закрытые сделки" value="12" subtitle="10 верифицировано" icon={<History className="h-4 w-4" />} /></div><Card className="max-w-xl"><div className="px-5 pt-4 text-sm font-medium uppercase tracking-wider text-muted-foreground">Сделки по типу среды</div><div className="space-y-4 p-5"><div className="flex justify-between border-b pb-2 text-sm font-medium uppercase tracking-wider"><span>Live (Реальные)</span><span className="font-mono text-lg">0</span></div><div className="flex justify-between text-sm font-medium uppercase tracking-wider"><span>Paper (Симуляция)</span><span className="font-mono text-lg">13</span></div></div></Card></div></div></main>
    </div>
  </div>;
}

export default Current;