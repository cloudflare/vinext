"use client";

import { GaugeIcon, GithubLogoIcon, GraphIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef } from "react";

type ThemeApi = {
  get(): "dark" | "light";
  toggle(): "dark" | "light";
};

function getThemeApi(): ThemeApi | null {
  const value = Reflect.get(window, "__vinextTheme");
  if (typeof value !== "object" || value === null) return null;
  const get = Reflect.get(value, "get");
  const toggle = Reflect.get(value, "toggle");
  if (typeof get !== "function" || typeof toggle !== "function") return null;

  return {
    get() {
      return Reflect.apply(get, value, []) === "light" ? "light" : "dark";
    },
    toggle() {
      return Reflect.apply(toggle, value, []) === "light" ? "light" : "dark";
    },
  };
}

function syncToggle(button: HTMLButtonElement) {
  const isLight = getThemeApi()?.get() === "light";
  button.setAttribute("aria-pressed", isLight ? "true" : "false");
  button.setAttribute("aria-label", isLight ? "Switch to dark theme" : "Switch to light theme");
}

export function SiteChrome() {
  const toggleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const button = toggleRef.current;
    if (!button) return;
    syncToggle(button);
    const observer = new MutationObserver(() => syncToggle(button));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  function toggleTheme() {
    const button = toggleRef.current;
    const theme = getThemeApi();
    if (!button || !theme) return;
    theme.toggle();
    syncToggle(button);
  }

  return (
    <nav className="site-chrome" aria-label="Primary">
      <Link className="site-wordmark" href="/">
        vinext
      </Link>
      <div className="site-actions">
        <Link className="chrome-link subtle-link" href="/benchmarks">
          <GaugeIcon size="1.2em" aria-hidden="true" />
          <span className="chrome-label">Benchmarks</span>
        </Link>
        <Link className="chrome-link subtle-link" href="/compatibility">
          <GraphIcon size="1.2em" aria-hidden="true" />
          <span className="chrome-label">Compatibility</span>
        </Link>
        <a className="chrome-link subtle-link" href="https://github.com/cloudflare/vinext">
          <GithubLogoIcon size="1.2em" aria-hidden="true" />
          <span className="chrome-label">GitHub</span>
        </a>
        <button
          ref={toggleRef}
          className="theme-toggle"
          type="button"
          aria-label="Switch to light theme"
          aria-pressed="false"
          onClick={toggleTheme}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <g className="sun">
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
            </g>
            <path className="moon" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        </button>
      </div>
    </nav>
  );
}
