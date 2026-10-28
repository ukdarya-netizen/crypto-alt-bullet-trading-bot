import { cn } from "@/lib/utils";

export function BrandMark({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-10 shrink-0 overflow-hidden rounded-full ring-1 ring-[hsl(var(--neon-violet)/0.6)] shadow-[0_0_14px_hsl(var(--neon-violet)/0.45),0_0_4px_hsl(var(--neon-cyan)/0.5)]",
        className,
      )}
    >
      <img
        src={`${import.meta.env.BASE_URL}brand-avatar.webp`}
        alt=""
        width={40}
        height={40}
        className="size-full object-cover"
        draggable={false}
      />
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
      aria-label={`Crypto Alts Bullet · ${product}`}
    >
      <BrandMark />
      <span aria-hidden="true" className="flex flex-col leading-none">
        <span className="brand-title text-[12px] uppercase">Crypto Alts</span>
        <span className="brand-bullet mt-0.5 text-[21px] uppercase">Bullet</span>
        <span className="mt-1 text-[9px] font-bold uppercase tracking-[0.22em] text-[hsl(var(--neon-cyan))]">
          {product}
        </span>
      </span>
    </div>
  );
}
