import { SignIn } from "@clerk/react";
import { Link } from "wouter";
import { BrandLockup } from "@/components/brand";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function SignInPage() {
  return (
    <div className="relative flex min-h-[100dvh] flex-col items-center justify-center gap-4 overflow-hidden bg-background px-4 py-8">
      <div className="pointer-events-none flex flex-col items-center text-center">
        <BrandLockup />
        <div className="mt-2 text-[9px] uppercase tracking-[.18em] text-muted-foreground">private trading journal · secure gateway</div>
      </div>
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
      <Link href="/sign-up" className="text-sm font-medium text-primary underline">Первый вход? Создать аккаунт</Link>
    </div>
  );
}
