import { Switch, Route, Link, useLocation } from "wouter";
import { useAuth, useClerk, useUser } from "@clerk/react";
import { LogOut, LayoutDashboard, List, History, ShieldAlert, Terminal, Wallet, Target, Database, Activity, FlaskConical, Users } from "lucide-react";
import { BrandLockup, BrandMark } from "@/components/brand";
import JournalOverview from "./JournalOverview";
import JournalSubscribers from "./JournalSubscribers";
import SubscriberCabinet from "./SubscriberCabinet";
import { useGetJournalAccess, getGetJournalAccessQueryKey } from "@workspace/api-client-react";
import JournalOpen from "./JournalOpen";
import JournalHistory from "./JournalHistory";
import JournalTradeDetail from "./JournalTradeDetail";
import JournalStrategies from "./JournalStrategies";
import JournalPositions from "./JournalPositions";
import JournalVstReview from "./JournalVstReview";
import JournalHealth from "./JournalHealth";

const NAV_ITEMS = [
  { href: "/journal/overview", label: "Обзор", short: "Обзор", sub: "прибыль, графики, стратегии", icon: LayoutDashboard },
  { href: "/journal/vst", label: "VST · бот", short: "VST", sub: "BingX демо, стратегия бота", icon: Database },
  { href: "/journal", label: "PAPER", short: "PAPER", sub: "симуляция", icon: FlaskConical },
  { href: "/journal/real", label: "REAL", short: "REAL", sub: "счёт BingX", icon: Wallet },
  { href: "/journal/strategies", label: "Стратегии", short: "Стратегии", sub: "4 схемы выхода по паттернам", icon: Target },
  { href: "/journal/open", label: "Открытые", short: "Открытые", sub: "все позиции сейчас", icon: List },
  { href: "/journal/history", label: "История", short: "История", sub: "все сделки", icon: History },
  { href: "/journal/health", label: "Bot Health", short: "Health", sub: "состояние бота", icon: Activity },
  { href: "/journal/subscribers", label: "Подписчики", short: "Подписчики", sub: "заявки и доступ", icon: Users },
] as const;

export default function JournalLayout() {
  const [location] = useLocation();
  const { signOut } = useClerk();
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const { data: access, isLoading, error } = useGetJournalAccess({
    query: { queryKey: getGetJournalAccessQueryKey(), enabled: Boolean(isLoaded && isSignedIn), refetchInterval: 15000 }
  });

  if (!isLoaded || (isSignedIn && isLoading)) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center">
         <div className="flex items-center gap-4 text-muted-foreground">
           <Terminal className="animate-pulse w-6 h-6" />
           <span className="font-mono text-sm tracking-widest uppercase">ИНИЦИАЛИЗАЦИЯ...</span>
         </div>
      </div>
    );
  }

  if (!isSignedIn) {
    return <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="max-w-md w-full border border-border bg-card p-8 space-y-5">
        <ShieldAlert className="w-10 h-10 text-primary" />
        <h1 className="text-xl font-bold uppercase">Личный дневник</h1>
        <p className="text-sm text-muted-foreground">Данные сделок доступны только владельцу после входа.</p>
        <Link href="/sign-in" className="block bg-primary text-primary-foreground text-center p-3 uppercase text-sm font-bold">Войти</Link>
      </div>
    </div>;
  }

  if (error || !access) {
    return <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="max-w-md w-full border border-border bg-card p-8 space-y-4">
        <h1 className="text-xl font-bold uppercase">Данные недоступны</h1>
        <p className="text-sm text-muted-foreground">Не удалось проверить доступ. Повторите попытку позже.</p>
      </div>
    </div>;
  }

  if (!access.configured) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        <div className="max-w-md w-full border border-border bg-card p-8 text-center space-y-6 shadow-sm">
          <Terminal className="w-12 h-12 mx-auto text-primary" />
          <h2 className="text-xl font-bold tracking-tight uppercase">Ожидание настройки владельца</h2>
          <p className="text-sm text-muted-foreground">
            Владелец ещё не назначен. Журнал закрыт для всех аккаунтов.
          </p>
          <button 
            onClick={() => signOut({ redirectUrl: "/" })}
            className="w-full bg-foreground text-background h-10 font-medium text-sm hover:bg-foreground/90 transition-colors uppercase tracking-wider"
          >
            Выйти
          </button>
        </div>
      </div>
    );
  }

  // Everyone who is not the owner gets the subscriber cabinet (request,
  // approval wait, key, strategy, start/stop).
  if (!access.authorized) {
    return <SubscriberCabinet />;
  }

  const current = NAV_ITEMS.find((item) => item.href === location) ??
    (location.startsWith("/journal/trades/") ? { label: "Сделка", sub: "подробности" } : null);

  return (
    <div className="cyber-shell min-h-[100dvh] bg-background flex flex-col md:flex-row">
      <aside className="cyber-sidebar hidden md:flex md:sticky md:top-0 md:h-[100dvh] w-64 border-r border-border flex-col flex-shrink-0">
        <div className="cyber-brand h-[72px] px-5 border-b border-border flex items-center">
          <BrandLockup />
        </div>
        <nav className="flex-1 py-4 px-3 space-y-0.5 overflow-y-auto" aria-label="Разделы">
          {NAV_ITEMS.map((item) => (
            <NavLink key={item.href} href={item.href} icon={item.icon} active={location === item.href} sub={item.sub}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-4 py-3 border-t border-border flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-foreground truncate">Владелец</p>
            <p className="text-xs text-muted-foreground truncate" title={user?.primaryEmailAddress?.emailAddress}>
              {user?.primaryEmailAddress?.emailAddress}
            </p>
          </div>
          <button
            onClick={() => signOut({ redirectUrl: "/" })}
            title="Выйти"
            aria-label="Выйти"
            className="shrink-0 p-1.5 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <header className="cyber-mobile-header sticky top-0 z-20 flex h-14 md:h-16 items-center justify-between gap-3 border-b border-border px-4 md:px-8">
          <div className="flex items-center gap-2.5 min-w-0">
            <BrandMark className="size-7 md:hidden" />
            <div className="min-w-0">
              <span className="block md:hidden text-[9px] uppercase tracking-[0.16em] text-muted-foreground">Crypto Alt Bullet</span>
              <h1 className="truncate text-base md:text-xl font-semibold">{current?.label ?? "Журнал"}</h1>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <span className="hidden md:inline text-xs text-muted-foreground">{current?.sub}</span>
            <button
              type="button"
              onClick={() => signOut({ redirectUrl: "/" })}
              className="md:hidden min-h-11 px-2 text-sm font-medium text-muted-foreground"
            >
              Выйти
            </button>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto p-4 pb-24 md:p-8">
           {(location === "/journal" || location === "/journal/real" || location === "/journal/vst" || location === "/journal/health") && (
             <nav aria-label="Переключить PAPER, REAL, VST и Bot Health" className="mx-auto mb-5 grid max-w-5xl grid-cols-2 border border-border bg-card p-1 sm:grid-cols-4" data-testid="account-page-switch">
              <SwitchLink href="/journal" active={location === "/journal"} testId="switch-to-paper">
                PAPER <span className="hidden sm:inline font-normal">· симуляция</span>
              </SwitchLink>
              <SwitchLink href="/journal/real" active={location === "/journal/real"} testId="switch-to-real" real>
                REAL <span className="hidden sm:inline font-normal">· счёт BingX</span>
              </SwitchLink>
              <SwitchLink href="/journal/vst" active={location === "/journal/vst"} testId="switch-to-vst">
                VST <span className="hidden sm:inline font-normal">· ledger</span>
              </SwitchLink>
              <SwitchLink href="/journal/health" active={location === "/journal/health"} testId="switch-to-health">
                <Activity className="h-4 w-4 shrink-0" aria-hidden="true" />
                Bot Health
              </SwitchLink>
            </nav>
          )}
          <Switch>
             <Route path="/journal/overview" component={JournalOverview} />
             <Route path="/journal/real">{() => <JournalPositions mode="real" />}</Route>
             <Route path="/journal/vst">{() => <JournalPositions mode="vst" />}</Route>
            <Route path="/journal/strategies" component={JournalStrategies} />
             <Route path="/journal">{() => <JournalPositions mode="paper" />}</Route>
            <Route path="/journal/open" component={JournalOpen} />
            <Route path="/journal/history" component={JournalHistory} />
            <Route path="/journal/health" component={JournalHealth} />
            <Route path="/journal/subscribers" component={JournalSubscribers} />
            <Route path="/journal/vst-review" component={JournalVstReview} />
            <Route path="/journal/trades/:id" component={JournalTradeDetail} />
          </Switch>
        </div>
         <nav aria-label="Разделы дневника" className="cyber-mobile-nav md:hidden fixed inset-x-0 bottom-0 z-20 flex overflow-x-auto border-t border-border pb-[env(safe-area-inset-bottom)]">
          {NAV_ITEMS.map((item) => (
            <MobileNavLink key={item.href} href={item.href} active={location === item.href} icon={item.icon}>
              {item.short}
            </MobileNavLink>
          ))}
        </nav>
      </main>
    </div>
  );
}

function SwitchLink({ href, active, testId, real = false, children }: {
  href: string; active: boolean; testId: string; real?: boolean; children: React.ReactNode;
}) {
  return (
    <Link href={href} aria-current={active ? "page" : undefined} data-testid={testId}
      className={`flex min-h-11 items-center justify-center gap-2 px-3 py-2 text-center text-xs font-bold uppercase tracking-wider transition-colors border ${
        active
          ? real ? "bg-amber-500/15 text-amber-200 border-amber-400/30" : "bg-primary/10 text-primary border-primary/20"
          : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}>
      {children}
    </Link>
  );
}

function MobileNavLink({ href, icon: Icon, active, children }: { href: string; icon: typeof LayoutDashboard; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-16 min-w-[68px] flex-1 flex-col items-center justify-center gap-1 px-1 text-[11px] font-medium ${active ? "text-primary" : "text-muted-foreground"}`}
    >
      <Icon className="w-5 h-5" />
      {children}
    </Link>
  );
}

function NavLink({ href, icon: Icon, active, sub, children }: { href: string; icon: typeof LayoutDashboard; active: boolean; sub?: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      data-active={active}
      aria-current={active ? "page" : undefined}
      className={`cyber-nav-link flex items-start px-3 py-2.5 text-sm font-medium transition-colors ${
        active ? "text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      <Icon className="w-4 h-4 mr-3 mt-0.5 shrink-0" />
      <span className="flex min-w-0 flex-col">
        <span>{children}</span>
        {sub && <span className={`text-xs font-normal ${active ? "text-primary/60" : "text-muted-foreground/60"}`}>{sub}</span>}
      </span>
    </Link>
  );
}
