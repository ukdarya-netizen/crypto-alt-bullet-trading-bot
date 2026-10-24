import { useEffect, useRef } from "react";
import { ClerkProvider, Show, useClerk } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { Switch, Route, useLocation, Router as WouterRouter } from 'wouter';
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { QueryClient } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';

import HomeRedirect from "@/pages/HomeRedirect";
import SignInPage from "@/pages/SignIn";
import SignUpPage from "@/pages/SignUp";
import JournalLayout from "@/pages/JournalLayout";
import NotFound from '@/pages/not-found';
import { ErrorBoundary } from '@/components/error-boundary';

const queryClient = new QueryClient();

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY in .env file');
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(189 77% 59%)",
    colorForeground: "hsl(216 27% 92%)",
    colorMutedForeground: "hsl(220 12% 65%)",
    colorDanger: "hsl(0 84% 63%)",
    colorBackground: "hsl(231 23% 8%)",
    colorInput: "hsl(230 27% 5%)",
    colorInputForeground: "hsl(216 27% 92%)",
    colorNeutral: "hsl(235 18% 19%)",
    colorTextOnPrimaryBackground: "hsl(230 35% 8%)",
    fontFamily: "'Space Mono', monospace",
    borderRadius: "0px",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-card rounded-none w-[440px] max-w-full overflow-hidden border border-border shadow-[0_18px_60px_rgba(0,0,0,.35)]",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-xl font-bold tracking-tight text-foreground",
    headerSubtitle: "text-sm text-muted-foreground",
    socialButtonsBlockButtonText: { color: "hsl(216 27% 92%)", fontWeight: 600 },
    formFieldLabel: "text-sm font-medium text-foreground",
    footerActionLink: "text-primary hover:underline",
    footerActionText: "text-muted-foreground",
    dividerText: "text-muted-foreground text-xs",
    identityPreviewEditButton: "text-primary",
    formFieldSuccessText: "text-success text-sm",
    alertText: "text-sm",
    logoBox: "mb-6 flex justify-center",
    logoImage: "h-12 w-auto",
    socialButtonsBlockButton: "rounded-none border border-border bg-background hover:bg-secondary transition-colors",
    formButtonPrimary: "rounded-none bg-primary text-primary-foreground hover:bg-primary/90 transition-colors font-medium h-10",
    formFieldInput: "rounded-none border border-input bg-background text-foreground h-10 px-3",
    footerAction: "!hidden",
    dividerLine: "bg-border",
    alert: "rounded-none border border-destructive/20 bg-destructive/10 text-destructive",
    otpCodeFieldInput: "rounded-none border border-input",
    formFieldRow: "mb-4",
    main: "px-8 py-6",
  },
};

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Вход в систему",
            subtitle: "Доступ к приватному журналу",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <ClerkQueryClientCacheInvalidator />
          <RoutedErrorBoundary>
            <Switch>
              <Route path="/" component={HomeRedirect} />
              <Route path="/sign-in/*?" component={SignInPage} />
              <Route path="/sign-up/*?" component={SignUpPage} />
              <Route path="/journal/*?" component={JournalLayout} />
              <Route component={NotFound} />
            </Switch>
          </RoutedErrorBoundary>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function RoutedErrorBoundary({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

export default function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}
