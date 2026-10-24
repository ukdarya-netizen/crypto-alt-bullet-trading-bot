import { SignUp } from "@clerk/react";
import { Link } from "wouter";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SignUpPage() {
  return (
    <div className="relative flex min-h-[100dvh] flex-col items-center justify-center gap-4 overflow-hidden bg-background px-4 py-8">
      <div className="pointer-events-none absolute left-1/2 top-8 -translate-x-1/2 text-center">
        <div className="font-mono text-[10px] tracking-[.28em] text-primary">CAB / JNL</div>
        <div className="mt-2 text-[9px] uppercase tracking-[.18em] text-muted-foreground">owner registration gateway</div>
      </div>
      <p className="text-center text-sm text-muted-foreground">Доступ к данным получит только назначенный владелец.</p>
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
      <Link href="/sign-in" className="text-sm font-medium text-primary underline">Уже есть аккаунт? Войти</Link>
    </div>
  );
}
