import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "dark" | "danger";

const variants: Record<Variant, string> = {
  primary: "bg-brand text-white hover:bg-brand-dark disabled:bg-[#8a958e]",
  secondary: "border border-line-strong bg-surface text-ink hover:bg-tint",
  dark: "bg-ink text-white hover:bg-black",
  danger: "border border-warn-line bg-warn-soft text-warn-ink hover:bg-[#ffe9da]",
};

export function Button({ variant = "primary", className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`inline-flex min-h-11 cursor-pointer items-center justify-center rounded-xl px-5 py-2.5 font-semibold transition-colors disabled:cursor-default ${variants[variant]} ${className}`}
      {...props}
    />
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-[20px] border border-line bg-surface p-6 ${className}`}>{children}</div>;
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <h3 className="font-display text-[19px] font-semibold">{children}</h3>;
}

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg width="30" height="30" viewBox="0 0 30 30" fill="none" aria-hidden="true">
        <rect x="3" y="9" width="24" height="17" rx="4" stroke="#04704F" strokeWidth="2.2" />
        <path d="M8 9c0-3.3 3.1-6 7-6s7 2.7 7 6" stroke="#04704F" strokeWidth="2.2" />
        <path d="M3 15h24" stroke="#04704F" strokeWidth="2.2" />
        <rect x="12.5" y="13" width="5" height="5" rx="1.2" fill="#0AC18E" />
      </svg>
      <span className="font-display text-[21px] font-bold tracking-tight">Satchel</span>
    </div>
  );
}

export function Spinner() {
  return <span aria-hidden="true" className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}
