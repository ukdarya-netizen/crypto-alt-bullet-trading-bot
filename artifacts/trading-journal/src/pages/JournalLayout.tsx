import { Switch, Route, Link, useLocation } from "wouter";
import { useAuth, useClerk, useUser } from "@clerk/react";
import { LogOut, LayoutDashboard, List, History, ShieldAlert, Terminal, Wallet, Target, Database, Activity } from "lucide-react";
import { useGetJournalAccess, getGetJournalAccessQueryKey } from "@workspace/api-client-react";
import JournalOpen from "./JournalOpen";
import JournalHistory from "./JournalHistory";
import JournalTradeDetail from "./JournalTradeDetail";
import JournalStrategies from "./JournalStrategies";
import JournalPositions from "./JournalPositions";
import JournalVstReview from "./JournalVstReview";
import JournalHealth from "./JournalHealth";

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

  if (!access.authorized) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        <div className="max-w-md w-full border border-border bg-card p-8 text-center space-y-6 shadow-sm">
          <ShieldAlert className="w-12 h-12 mx-auto text-destructive" />
          <h2 className="text-xl font-bold tracking-tight uppercase">Доступ запрещён</h2>
          <p className="text-sm text-muted-foreground">
            Этот журнал доступен только назначенному владельцу.
          </p>
          <button 
            onClick={() => signOut({ redirectUrl: "/" })}
            className="text-xs text-muted-foreground hover:text-foreground underline uppercase tracking-wider mt-4"
          >
            Выйти
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="cyber-shell min-h-[100dvh] bg-background flex flex-col md:flex-row">
      <aside className="cyber-sidebar hidden md:flex w-64 border-r border-border bg-card flex-col flex-shrink-0">
        <div className="cyber-brand p-6 border-b border-border flex items-center gap-3">
          <div className="relative grid h-7 w-7 shrink-0 rotate-45 place-items-center border-2 border-primary shadow-[0_0_18px_hsl(var(--primary)/.35)]">
            <div className="h-3.5 w-3.5 bg-success" />
          </div>
          <div className="min-w-0">
            <span className="block font-bold text-sm tracking-[.13em] uppercase truncate">CAB / JNL</span>
            <span className="mt-0.5 block font-mono text-[9px] tracking-[.13em] text-muted-foreground">CRYPTO ALT BULLET</span>
          </div>
        </div>
        <nav className="flex-1 p-4 space-y-1 overflow-y-auto">
           <NavLink href="/journal" icon={LayoutDashboard} active={location === "/journal"}>
             PAPER · симуляция
           </NavLink>
           <NavLink href="/journal/real" icon={Wallet} active={location === "/journal/real"}>
              REAL · счёт BingX
          </NavLink>
           <NavLink href="/journal/vst" icon={Database} active={location === "/journal/vst"}>
              VST · ledger
           </NavLink>
           <NavLink href="/journal/strategies" icon={Target} active={location === "/journal/strategies"}>
             Стратегии
           </NavLink>
          <NavLink href="/journal/open" icon={List} active={location === "/journal/open"}>
            Открытые позиции
          </NavLink>
          <NavLink href="/journal/history" icon={History} active={location === "/journal/history"}>
            История сделок
          </NavLink>
          <NavLink href="/journal/health" icon={Activity} active={location === "/journal/health"}>
            Bot Health
          </NavLink>
        </nav>
        <div className="p-4 border-t border-border space-y-4">
          <div className="text-xs text-muted-foreground font-mono truncate px-2" title={user?.primaryEmailAddress?.emailAddress}>
            {user?.primaryEmailAddress?.emailAddress}
          </div>
          <button 
            onClick={() => signOut({ redirectUrl: "/" })}
            className="flex w-full items-center gap-3 px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors uppercase tracking-wider"
          >
            <LogOut className="w-4 h-4" />
            Выйти
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <header className="cyber-mobile-header md:hidden flex h-14 items-center justify-between gap-3 border-b border-border bg-card px-4">
          <span className="font-bold text-sm tracking-[.1em] uppercase">CAB / JNL</span>
            <span className={`font-mono text-[9px] ${location === "/journal/real" ? "text-amber-300" : "text-primary"}`}>
               {location === "/journal/real" ? "REAL ACCOUNT" : location === "/journal/vst" ? "VST LEDGER" : location === "/journal/health" ? "BOT HEALTH" : location === "/journal" ? "PAPER" : "PRIVATE JOURNAL"}
           </span>
          <button
            type="button"
            onClick={() => signOut({ redirectUrl: "/" })}
            className="min-h-11 px-2 text-sm font-medium text-muted-foreground"
          >
            Выйти
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4 pb-24 md:p-8">
           {(location === "/journal" || location === "/journal/real" || location === "/journal/vst" || location === "/journal/health") && (
             <nav aria-label="Переключить PAPER, REAL, VST и Bot Health" className="mx-auto mb-5 grid max-w-5xl grid-cols-2 border border-border bg-card/60 p-1 sm:grid-cols-4" data-testid="account-page-switch">
              <Link href="/journal" aria-current={location === "/journal" ? "page" : undefined}
                data-testid="switch-to-paper"
                className={`flex min-h-11 items-center justify-center gap-2 px-3 py-2 text-center text-xs font-bold uppercase tracking-wider transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                  location === "/journal" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}>
                PAPER <span className="hidden sm:inline font-normal">· симуляция</span>
              </Link>
              <Link href="/journal/real" aria-current={location === "/journal/real" ? "page" : undefined}
                data-testid="switch-to-real"
                className={`flex min-h-11 items-center justify-center gap-2 px-3 py-2 text-center text-xs font-bold uppercase tracking-wider transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 ${
                  location === "/journal/real" ? "bg-amber-500/20 text-amber-200" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                }`}>
                 REAL <span className="hidden sm:inline font-normal">· счёт BingX</span>
              </Link>
               <Link href="/journal/vst" aria-current={location === "/journal/vst" ? "page" : undefined}
                 data-testid="switch-to-vst"
                 className={`flex min-h-11 items-center justify-center gap-2 px-3 py-2 text-center text-xs font-bold uppercase tracking-wider transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                   location === "/journal/vst" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                 }`}>
                 VST <span className="hidden sm:inline font-normal">· ledger</span>
               </Link>
                <Link href="/journal/health" aria-current={location === "/journal/health" ? "page" : undefined}
                  data-testid="switch-to-health"
                  className={`flex min-h-11 items-center justify-center gap-2 px-3 py-2 text-center text-xs font-bold uppercase tracking-wider transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                    location === "/journal/health" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                  }`}>
                  <Activity className="h-4 w-4 shrink-0" aria-hidden="true" />
                  Bot Health
                </Link>
            </nav>
          )}
          <Switch>
             <Route path="/journal/real">{() => <JournalPositions mode="real" />}</Route>
             <Route path="/journal/vst">{() => <JournalPositions mode="vst" />}</Route>
            <Route path="/journal/strategies" component={JournalStrategies} />
             <Route path="/journal">{() => <JournalPositions mode="paper" />}</Route>
            <Route path="/journal/open" component={JournalOpen} />
            <Route path="/journal/history" component={JournalHistory} />
            <Route path="/journal/health" component={JournalHealth} />
            <Route path="/journal/vst-review" component={JournalVstReview} />
            <Route path="/journal/trades/:id" component={JournalTradeDetail} />
          </Switch>
        </div>
         <nav aria-label="Разделы дневника" className="cyber-mobile-nav md:hidden fixed inset-x-0 bottom-0 z-20 grid grid-cols-7 border-t border-border bg-card pb-[env(safe-area-inset-bottom)]">
          <MobileNavLink href="/journal" active={location === "/journal"} icon={LayoutDashboard}>PAPER</MobileNavLink>
          <MobileNavLink href="/journal/real" active={location === "/journal/real"} icon={Wallet}>REAL</MobileNavLink>
           <MobileNavLink href="/journal/vst" active={location === "/journal/vst"} icon={Database}>VST</MobileNavLink>
          <MobileNavLink href="/journal/strategies" active={location === "/journal/strategies"} icon={Target}>Стратегии</MobileNavLink>
          <MobileNavLink href="/journal/open" active={location === "/journal/open"} icon={List}>Открытые</MobileNavLink>
          <MobileNavLink href="/journal/history" active={location === "/journal/history"} icon={History}>История</MobileNavLink>
          <MobileNavLink href="/journal/health" active={location === "/journal/health"} icon={Activity}>
            <span className="text-center text-[10px] leading-tight">Bot<br />Health</span>
          </MobileNavLink>
        </nav>
      </main>
    </div>
  );
}

function MobileNavLink({ href, icon: Icon, active, children }: { href: string; icon: typeof LayoutDashboard; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`flex min-h-16 flex-col items-center justify-center gap-1 text-xs font-medium ${active ? "text-primary" : "text-muted-foreground"}`}
    >
      <Icon className="w-5 h-5" />
      {children}
    </Link>
  );
}

function NavLink({ href, icon: Icon, active, children }: { href: string; icon: any; active: boolean; children: React.ReactNode }) {
  return (
    <Link 
      href={href} 
      data-active={active}
      className={`cyber-nav-link flex items-center gap-3 px-3 py-2 text-sm font-medium transition-colors ${
        active ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-secondary"
      }`}
    >
      <Icon className="w-4 h-4" />
      {children}
    </Link>
  );
}
