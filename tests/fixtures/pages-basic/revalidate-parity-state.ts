type RevalidateParityMode =
  | "content"
  | "notFound"
  | "redirect"
  | "externalRedirect"
  | "concurrent"
  | "error";

type RevalidateParityState = {
  mode: RevalidateParityMode;
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
    capturedCookie: null,
    capturedToken: null,
    generationCount: 0,
  });
}

export function setRevalidateParityMode(mode: RevalidateParityMode): void {
  getRevalidateParityState().mode = mode;
}

export function resetRevalidateParityGenerationCount(): void {
  getRevalidateParityState().generationCount = 0;
}

export function incrementRevalidateParityGenerationCount(): void {
  getRevalidateParityState().generationCount++;
}
