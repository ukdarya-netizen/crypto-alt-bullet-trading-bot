import { SignUp } from "@clerk/react";
import { Link } from "wouter";
import { BrandLockup } from "@/components/brand";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SignUpPage() {
  return (
    <div className="relative flex min-h-[100dvh] flex-col items-center justify-center gap-4 overflow-hidden bg-background px-4 py-8">
      <div className="pointer-events-none flex flex-col items-center text-center">
        <BrandLockup />
        <div className="mt-2 text-[9px] uppercase tracking-[.18em] text-muted-foreground">owner registration gateway</div>
      </div>
      <p className="text-center text-sm text-muted-foreground">Доступ к данным получит только назначенный владелец.</p>
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
      <Link href="/sign-in" className="text-sm font-medium text-primary underline">Уже есть аккаунт? Войти</Link>
    </div>
  );
}
