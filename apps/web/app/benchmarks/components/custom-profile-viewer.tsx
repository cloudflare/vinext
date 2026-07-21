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
    <section className="rounded-lg border border-gray-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <h2 className="text-lg font-semibold">Custom Profile</h2>
          {profileState.status === "ready" && (
            <div className="mt-1 font-mono text-xs text-gray-500">{profileState.fileName}</div>
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
              className="inline-flex size-9 items-center justify-center rounded-lg border border-gray-200 text-gray-500 transition hover:border-gray-300 hover:bg-gray-50 hover:text-gray-900"
              aria-label="Clear custom profile"
              title="Clear custom profile"
            >
              <X size={16} />
            </button>
          )}
          <button
            type="button"
            onClick={chooseProfile}
            className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-black disabled:cursor-wait disabled:bg-gray-500"
            disabled={profileState.status === "loading"}
          >
            <FileArrowUp size={16} />
            {profileState.status === "loading" ? "Parsing" : "Open Profile"}
          </button>
        </div>
      </div>
      {profileState.status === "error" && (
        <div className="border-t border-red-100 bg-red-50 px-5 py-3 text-sm text-red-700">
          {profileState.message}
        </div>
      )}
      {profileState.status === "ready" && (
        <div className="border-t border-gray-200 bg-slate-950 p-5 text-white">
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
