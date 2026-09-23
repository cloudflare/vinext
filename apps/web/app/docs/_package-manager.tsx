"use client";

import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";

const packageManagers = ["pnpm", "npm", "yarn", "bun", "vp"] as const;
type PackageManager = (typeof packageManagers)[number];

const storageKey = "vinext:package-manager";
const changeEvent = "vinext-package-manager-change";
const PackageManagerContext = createContext({
  packageManager: "pnpm" as PackageManager,
  selectPackageManager: (_packageManager: PackageManager) => {},
});

export function PackageManagerProvider({ children }: { children: ReactNode }) {
  const packageManager = useSyncExternalStore<PackageManager>(
    (notify) => {
      window.addEventListener("storage", notify);
      window.addEventListener(changeEvent, notify);
      return () => {
        window.removeEventListener("storage", notify);
        window.removeEventListener(changeEvent, notify);
      };
    },
    () => {
      const stored = localStorage.getItem(storageKey);
      return packageManagers.find((value) => value === stored) ?? "pnpm";
    },
    () => "pnpm",
  );

  function selectPackageManager(nextPackageManager: PackageManager) {
    localStorage.setItem(storageKey, nextPackageManager);
    window.dispatchEvent(new Event(changeEvent));
  }

  return (
    <PackageManagerContext.Provider value={{ packageManager, selectPackageManager }}>
      {children}
    </PackageManagerContext.Provider>
  );
}

export function PackageManagerCommand({ commands }: { commands: Record<PackageManager, string> }) {
  const { packageManager: selected, selectPackageManager } = useContext(PackageManagerContext);

  return (
    <div className="my-5 overflow-hidden rounded-lg bg-kumo-contrast text-kumo-inverse">
      <div
        role="group"
        aria-label="Package manager"
        className="flex gap-1 border-b border-white/15 px-2 py-1.5"
      >
        {packageManagers.map((packageManager) => (
          <button
            key={packageManager}
            type="button"
            aria-pressed={selected === packageManager}
            onClick={() => selectPackageManager(packageManager)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              selected === packageManager ? "bg-white/15" : "opacity-65 hover:opacity-100"
            }`}
          >
            {packageManager}
          </button>
        ))}
      </div>
      <pre className="overflow-x-auto p-4 text-sm leading-7">
        <code>{commands[selected].trim()}</code>
      </pre>
    </div>
  );
}
