"use client";

import { buttonVariants } from "@cloudflare/kumo/components/button";
import { GaugeIcon, GithubLogoIcon, GraphIcon } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

const navButton = buttonVariants({ variant: "ghost", size: "sm" });

export function SiteHeader() {
  return (
    <header className="w-full border-b border-kumo-hairline">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-4">
        <Link href="/" className="flex items-center gap-2">
          <span className="font-semibold tracking-tight text-kumo-default">vinext</span>
        </Link>
        <nav className="flex items-center gap-2">
          <Link href="/compatibility" className={navButton}>
            <GraphIcon />
            Compatibility
          </Link>
          <Link href="/benchmarks" className={navButton}>
            <GaugeIcon />
            Benchmarks
          </Link>
          <a
            href="https://github.com/cloudflare/vinext"
            target="_blank"
            rel="noopener noreferrer"
            className={navButton}
          >
            <GithubLogoIcon />
            GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}
