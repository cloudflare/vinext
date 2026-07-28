import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Not found" };

// Renders inside the root layout, so chrome + footer + theme come for free.
// Styled as terminal output to match the brand's CLI framing.
export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 py-32 text-center">
      <p className="m-0 font-mono text-[13px] tracking-[0.08em] text-[var(--mute)] uppercase">
        Error 404
      </p>
      <h1 className="mt-4 mb-0 font-sans text-[clamp(44px,8vw,96px)] leading-[0.95] font-bold tracking-[-0.04em] text-[var(--ink)]">
        Route <span className="text-[var(--orange)]">not found.</span>
      </h1>
      <div className="mt-10 w-full max-w-105 rounded-[13px] border border-[var(--line)] bg-[rgba(var(--surface-rgb),0.65)] p-5 text-left font-mono text-[13px] leading-relaxed backdrop-blur-[6px]">
        <p className="nf-line m-0 text-[var(--mute)]">
          <span aria-hidden="true">$ </span>vinext resolve
        </p>
        <p className="nf-line m-0 mt-1 text-[var(--unsupported)] [animation-delay:90ms]">
          ✗ no route matched this URL
        </p>
        <p className="nf-line m-0 mt-1 text-[var(--ink-sub)] [animation-delay:180ms]">
          → try one of the routes below
        </p>
      </div>
      <nav className="mt-8 flex flex-wrap items-center justify-center gap-6 font-mono text-[13px]">
        <Link className="text-link no-underline" href="/">
          Home
        </Link>
        <Link className="text-link no-underline" href="/compatibility">
          Compatibility
        </Link>
        <Link className="text-link no-underline" href="/benchmarks">
          Benchmarks
        </Link>
      </nav>
    </div>
  );
}
