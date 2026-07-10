type RevalidateParityMode = "content" | "notFound" | "redirect";

type RevalidateParityState = {
  mode: RevalidateParityMode;
  capturedCookie: string | null;
  capturedToken: string | null;
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
  });
}

export function setRevalidateParityMode(mode: RevalidateParityMode): void {
  getRevalidateParityState().mode = mode;
}
