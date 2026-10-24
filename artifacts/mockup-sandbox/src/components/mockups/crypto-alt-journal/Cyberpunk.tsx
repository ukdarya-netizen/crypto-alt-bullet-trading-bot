import { Activity, CheckCircle2, History, LayoutDashboard, List, LogOut, Target, Wallet, ShieldAlert, Zap } from "lucide-react";
import "./Cyberpunk.css";

type Signal = { id: string; symbol: string; source: string; pattern: string; status: string; detail?: string };

const signals: Signal[] = [
  { id: "sig_2025_02_14_001", symbol: "BTCUSDT", source: "bullet-webhook-8f3a", pattern: "impulse_buy", status: "В очереди" },
  { id: "sig_2025_02_13_017", symbol: "ETHUSDT", source: "bullet-webhook-1c92", pattern: "liquidation_cascade", status: "Бумажный ордер создан" },
  { id: "sig_2025_02_12_009", symbol: "SOLUSDT", source: "manual-review", pattern: "impulse_buy", status: "Не открыта · недостаточно средств", detail: "Недостаточно средств для открытия позиции" },
];

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`cp-card ${className}`}>{children}</div>;
}

function Metric({ title, value, icon, tone = "", subtitle }: { title: string; value: string; icon: React.ReactNode; tone?: string; subtitle?: string }) {
  return <Card className="cp-stat"><label>{title}</label><span className="cp-metric-icon">{icon}</span><strong className={tone}>{value}</strong>{subtitle && <p>{subtitle}</p>}</Card>;
}

function BulletPaperBot() {
  return <section className="cp-section">
    <div className="cp-section-head"><h2>01 / Активный PAPER-бот</h2><p>контур симуляции · refresh 15 сек</p></div>
    <div className="cp-bot-intro">
      <div><h3>Bullet <span className="cp-mono" style={{ color: "var(--cp-cyan)" }}>PAPER</span></h3><p>Источник bullet-paper-store · только симуляция. Приватный API BingX (mainnet, только проверка): подключён · чтение доступно. Ключи не используются для PAPER-ордера.</p>
        <div className="cp-safety"><strong><ShieldAlert size={13} style={{ verticalAlign: "middle", marginRight: 6 }} />Подготовка реальной торговли · запуск заблокирован</strong>Это только чтение состояния BingX; ордера и настройки биржи не изменяются. Проверки счёта в макете не выполняются; реальное исполнение заблокировано.</div>
      </div>
      <span className="cp-pill"><i className="cp-dot" />PAPER · ACTIVE</span>
    </div>
    <Card className="cp-wallet"><div className="cp-wallet-head"><Wallet size={15} />Кошелёк активного бота · USDT</div><div className="cp-wallet-grid">
      {["Начальный|100.00", "Свободно|73.40", "Зарезервировано|26.60", "Реализованный PnL|+4.82"].map((item) => { const [label, value] = item.split("|"); return <div className="cp-wallet-item" key={label}><label>{label}</label><strong>{value} <small>USDT</small></strong></div>; })}
    </div></Card>
    <Card className="cp-feed"><div className="cp-card-title"><Activity />Последние сигналы бота <span className="cp-mono" style={{ color: "var(--cp-muted)" }}>(3)</span></div>{signals.slice(0, 2).map((signal) => <div className="cp-list-row" key={signal.id}><div><div className="cp-list-id">{signal.id}</div><div className="cp-list-meta">Получен: 14.02.2025 10:42 · Обновлён: 14.02.2025 10:42</div></div><span className={`cp-status ${signal.status.includes("создан") ? "green" : ""}`}>{signal.status}</span></div>)}</Card>
    <Card className="cp-position"><div className="cp-card-title"><Target />Открытые позиции активного PAPER-бота <span className="cp-mono" style={{ color: "var(--cp-muted)" }}>(1)</span></div><div className="cp-position-body"><div><label>Инструмент</label><strong style={{ color: "var(--cp-green)" }}>ETHUSDT</strong><small>sig_2025_02_13_017</small></div><div><label>Количество / остаток</label><strong>0.018 / 0.018</strong></div><div><label>Вход / стоп</label><strong>2,712.40 / 2,658.10</strong></div><div><label>Стратегия</label><strong style={{ fontSize: 11 }}>liquidation_cascade · open</strong><small>Вход: 13.02.2025 18:20</small></div></div><div className="cp-pager">Данные из отдельного PAPER-хранилища · не биржевой баланс · не legacy-записи</div></Card>
  </section>;
}

function Legacy() {
  return <section className="cp-section cp-legacy"><div className="cp-section-head"><div><h2>02 / Legacy-журнал</h2><p className="cp-legacy-note">Прежний учёт по записанным ордерам, отдельно от активного PAPER-бота Bullet.</p></div></div>
    <Card className="cp-deposit"><div className="cp-deposit-title"><Wallet /><div><strong>Депозит симулятора</strong><span>Начальный депозит: $100.00 USD</span></div></div><div className="cp-balance"><label>Расчётный баланс</label><strong>$116.40</strong><span className="cp-list-meta">Занято: $26.60 · Свободно: $89.80</span></div><div className="cp-deposit-copy">Прежний бумажный учёт записанных сделок, не кошелёк активного Bullet PAPER-бота. Валовой результат без комиссий и открытого PnL.</div></Card>
    <Card className="cp-inbox"><div className="cp-card-title"><Zap />Полученные и неоткрытые сигналы</div>{signals.map((signal) => <div className="cp-list-row" key={signal.id}><div className="cp-signal-main"><div className="cp-symbol">{signal.symbol}</div><div><div className="cp-signal-source">{signal.source} · 14.02.2025 10:42</div><div className="cp-signal-detail">{signal.pattern.replaceAll("_", " ")} · цена сигнала 67,420.0000{signal.detail && ` · ${signal.detail}`}</div></div></div><span className={`cp-status ${signal.status.includes("создан") ? "green" : ""}`}>{signal.status}</span></div>)}<div className="cp-pager"><span>Новые</span><span>Страница 1</span><span>Ранее →</span></div></Card>
  </section>;
}

export function Cyberpunk() {
  return <div className="cyberpunk-journal"><div className="cp-topbar"><ShieldAlert size={12} /> Визуальный макет · данные примера <span>не состояние счёта · не сигнал к торговле</span></div><div className="cp-shell">
    <aside className="cp-sidebar"><div className="cp-brand"><div className="cp-brand-mark" /><div><div className="cp-brand-title">CAB / JNL</div><div className="cp-brand-sub">crypto alt bullet</div></div></div><nav className="cp-nav"><div className="cp-nav-label">Навигация</div><div className="cp-nav-item active"><LayoutDashboard />Сводка</div><div className="cp-nav-item"><List />Открытые позиции</div><div className="cp-nav-item"><History />История сделок</div></nav><div className="cp-sidebar-foot"><div className="cp-identity">owner@cab-trading.dev</div><div className="cp-signout"><LogOut size={15} />Выйти</div></div></aside>
    <main className="cp-main"><header className="cp-mobile-head"><strong>CAB / JNL</strong><span>● PAPER ACTIVE</span></header><div className="cp-content"><header className="cp-page-head"><div><div className="cp-kicker">/ journal / overview</div><h1>Сводка портфеля</h1></div><div className="cp-source">Источник: <b>journal</b><br />14.02.2025 · 10:42:18</div></header><BulletPaperBot /><Legacy /><section className="cp-section"><div className="cp-stats"><Metric title="Реализованный PnL" value="$16.40" tone="positive" icon={<CheckCircle2 size={14} />} /><Metric title="Нереализованный PnL" value="+$2.84" tone="positive" icon={<Activity size={14} />} /><Metric title="Открытые сделки" value="1" tone="violet" icon={<Target size={14} />} /><Metric title="Закрытые сделки" value="12" subtitle="10 верифицировано" icon={<History size={14} />} /></div><Card className="cp-env"><div className="cp-card-title">Сделки по типу среды</div><div className="cp-env-line"><span>Live (Реальные)</span><strong>0</strong></div><div className="cp-env-line"><span>Paper (Симуляция)</span><strong>13</strong></div></Card></section></div></main>
  </div></div>;
}

export default Cyberpunk;