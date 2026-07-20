type RevalidateParityMode =
  | "content"
  | "notFound"
  | "redirect"
  | "permanentRedirect"
  | "basePathFalseRedirect"
  | "conflictingRedirect"
  | "invalidStatusRedirect"
  | "externalRedirect"
  | "promised"
  | "concurrent"
  | "error";

type RevalidateParityState = {
  mode: RevalidateParityMode;
  revalidate: unknown;
  capturedCookie: string | null;
  capturedToken: string | null;
  generationCount: number;
};

const stateKey = Symbol.for("vinext.fixture.revalidateParityState");
const fixtureGlobal = globalThis as typeof globalThis & {
  [stateKey]?: RevalidateParityState;
};

export function getRevalidateParityState(): RevalidateParityState {
  return (fixtureGlobal[stateKey] ??= {
    mode: "content",
    revalidate: undefined,
    capturedCookie: null,
    capturedToken: null,
    generationCount: 0,
  });
}

export function setRevalidateParityMode(mode: RevalidateParityMode, revalidate?: unknown): void {
  const state = getRevalidateParityState();
  state.mode = mode;
  state.revalidate = revalidate;
}

export function resetRevalidateParityGenerationCount(): void {
  getRevalidateParityState().generationCount = 0;
}

export function incrementRevalidateParityGenerationCount(): void {
  getRevalidateParityState().generationCount++;
}
