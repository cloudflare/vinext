"use client";

import { useRef, useState } from "react";
import { FileArrowUp, X } from "@phosphor-icons/react";
import { FlameGraph, type FlameGraphNode } from "./performance-comparison";
import { profileToFlameGraph, readProfileFile } from "./profile";

type ProfileState =
  | { status: "idle" }
  | { status: "loading"; fileName: string }
  | { status: "ready"; fileName: string; profileKey: string; flameGraph: FlameGraphNode }
  | { status: "error"; fileName?: string; message: string };

export function CustomProfileViewer() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [profileState, setProfileState] = useState<ProfileState>({ status: "idle" });

  const chooseProfile = () => inputRef.current?.click();
  const clearProfile = () => {
    if (inputRef.current) inputRef.current.value = "";
    setProfileState({ status: "idle" });
  };

  const loadProfile = async (file: File) => {
    setProfileState({ status: "loading", fileName: file.name });
    try {
      const graph = profileToFlameGraph(await readProfileFile(file));
      if (!graph) throw new Error("Profile contains no samples.");
      setProfileState({
        status: "ready",
        fileName: file.name,
        profileKey: `${file.name}:${file.size}:${file.lastModified}`,
        flameGraph: graph,
      });
    } catch (error) {
      setProfileState({
        status: "error",
        fileName: file.name,
        message: error instanceof Error ? error.message : "Profile could not be parsed.",
      });
    }
  };

  return (
    <section className="rounded-lg border border-[var(--line)] bg-[var(--surface)]">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="text-lg font-semibold">Custom Profile</h2>
          {profileState.status === "ready" && (
            <div className="mt-1 font-mono text-xs text-[var(--sub)]">{profileState.fileName}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".json,.gz,.json.gz,application/json,application/gzip"
            className="sr-only"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void loadProfile(file);
            }}
          />
          {profileState.status === "ready" && (
            <button
              type="button"
              onClick={clearProfile}
              className="inline-flex size-9 items-center justify-center rounded-lg border border-[var(--line)] text-[var(--sub)] transition hover:border-[var(--faint)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]"
              aria-label="Clear custom profile"
              title="Clear custom profile"
            >
              <X size={16} />
            </button>
          )}
          <button
            type="button"
            onClick={chooseProfile}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--orange)] px-3 py-2 text-sm font-medium text-[var(--on-accent)] transition hover:brightness-110 disabled:cursor-wait disabled:opacity-50"
            disabled={profileState.status === "loading"}
          >
            <FileArrowUp size={16} />
            {profileState.status === "loading" ? "Parsing" : "Open Profile"}
          </button>
        </div>
      </div>
      {profileState.status === "error" && (
        <div className="border-t border-red-500/20 bg-red-500/10 px-5 py-3 text-sm text-red-400">
          {profileState.message}
        </div>
      )}
      {profileState.status === "ready" && (
        <div className="border-t border-[var(--line)] bg-slate-950 p-5 text-white">
          <FlameGraph
            key={profileState.profileKey}
            flameGraph={profileState.flameGraph}
            ariaLabel={`${profileState.fileName} interactive flame graph`}
          />
        </div>
      )}
    </section>
  );
}
