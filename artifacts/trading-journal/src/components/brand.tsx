import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center border border-cyan-300/20 bg-[#101322]",
        className,
      )}
    >
      <svg viewBox="0 0 48 48" fill="none" className="size-[78%]">
        <defs>
          <linearGradient
            id="bullet-metal"
            x1="13"
            y1="32"
            x2="39"
            y2="10"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#864DDC" />
            <stop offset=".42" stopColor="#5FCDF2" />
            <stop offset=".72" stopColor="#E2F5FF" />
            <stop offset="1" stopColor="#56E9B7" />
          </linearGradient>
          <linearGradient
            id="bullet-body"
            x1="10"
            y1="33"
            x2="30"
            y2="16"
            gradientUnits="userSpaceOnUse"
          >
            <stop stopColor="#542D96" />
            <stop offset=".52" stopColor="#143D77" />
            <stop offset="1" stopColor="#73DCF0" />
          </linearGradient>
        </defs>
        <path
          d="M4 42 15 31M9 44l8-9"
          stroke="#A86CE5"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
        <path
          d="m12 28 17-17c3-3 7.2-4.3 12-5-1 4.8-2 9-5 12L19 35l-7-7Z"
          fill="url(#bullet-body)"
          stroke="url(#bullet-metal)"
          strokeWidth="1.5"
        />
        <path
          d="m17 30 20-20M22 33l16-16"
          stroke="#97E4F4"
          strokeOpacity=".7"
          strokeWidth="1.25"
          strokeLinecap="round"
        />
        <path
          d="m11 27 9 9-3 3-9-9 3-3Z"
          fill="#35305F"
          stroke="#AC74EC"
          strokeWidth="1.2"
        />
        <path d="m39 7 3-2-1 4" fill="#D9FFF0" />
      </svg>
    </span>
  );
}

export function BrandLockup({
  className,
  product = "Trading Bot",
}: {
  className?: string;
  product?: string;
}) {
  return (
    <div
      className={cn("inline-flex items-center gap-3 text-left", className)}
      aria-label={`Crypto Alt Bullet · ${product}`}
    >
      <BrandMark />
      <span aria-hidden="true" className="flex flex-col leading-none">
        <span className="mb-1 text-[10px] font-semibold uppercase tracking-[0.24em] text-[#9BAAC5]">
          Crypto
        </span>
        <span className="whitespace-nowrap text-[17px] font-bold tracking-[0.035em] text-foreground">
          <span className="text-[#67D9EC]">Alt</span> Bullet
        </span>
        <span className="mt-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#56E9B7]">
          {product}
        </span>
      </span>
    </div>
  );
}
