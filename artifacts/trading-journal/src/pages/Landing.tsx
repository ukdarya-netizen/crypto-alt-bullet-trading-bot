import { Link } from "wouter";
import { BrandLockup, BrandMark } from "@/components/brand";

export default function Landing() {
  return (
    <div className="cyber-landing min-h-[100dvh] bg-background flex flex-col">
      <header className="cyber-landing-header border-b border-border px-5 py-4 sm:px-8 flex items-center justify-between">
        <BrandLockup />
        <div className="flex items-center gap-4">
          <Link href="/sign-in" className="cyber-landing-login text-sm font-medium transition-colors">
            Войти
          </Link>
        </div>
      </header>
      
      <main className="cyber-landing-main flex-1 grid items-center px-5 py-14 sm:px-8 lg:px-14">
        <div className="cyber-landing-grid mx-auto grid w-full max-w-6xl items-center gap-14 lg:grid-cols-[1.1fr_.9fr]">
          <div className="text-left">
            <div className="cyber-kicker font-mono text-[10px] uppercase tracking-[.24em] text-primary">/ private journal / owner access</div>
            <h1 className="mt-5 max-w-3xl text-5xl font-bold leading-[.96] tracking-[-.055em] text-foreground sm:text-7xl">
              Личный<br /><span className="text-primary">торговый</span> дневник
            </h1>
            <p className="mt-7 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
              Сделки, сигналы и результаты в одном защищённом контуре. Войдите с телефона по своему email.
            </p>
            <div className="mt-9 space-y-4">
            <Link href="/sign-in" className="cyber-landing-cta flex min-h-12 w-full max-w-xs items-center justify-center px-8 text-base font-medium transition-colors">
              Войти в журнал
            </Link>
            <p className="text-sm text-muted-foreground">
              Первый раз? <Link href="/sign-up" className="text-primary underline font-medium">Создать аккаунт</Link>
            </p>
            </div>
            <p className="mt-12 max-w-md border-l-2 border-amber-400/70 pl-3 text-xs leading-5 text-muted-foreground">
              Доступ к данным получает только назначенный владелец. Реальное исполнение сделок отключено.
            </p>
          </div>
          <div className="cyber-landing-console" aria-label="Приватный торговый журнал">
            <div className="cyber-console-top"><span>JOURNAL CONSOLE</span><i>OWNER ONLY</i></div>
            <div className="cyber-console-orbit"><BrandMark className="size-24 border-primary/30" /></div>
            <div className="cyber-console-line"><span>MODE</span><strong>PAPER-FIRST</strong></div>
            <div className="cyber-console-line"><span>ACCESS</span><strong className="text-primary">PRIVATE</strong></div>
            <div className="cyber-console-line"><span>EXECUTION</span><strong className="text-amber-300">BLOCKED</strong></div>
            <div className="cyber-console-footer font-mono">signals / positions / history</div>
          </div>
        </div>
      </main>

      <footer className="border-t border-border py-8 text-center text-sm text-muted-foreground">
        &copy; {new Date().getFullYear()} Crypto Alt Bullet. Приватный инструмент.
      </footer>
    </div>
  );
}
