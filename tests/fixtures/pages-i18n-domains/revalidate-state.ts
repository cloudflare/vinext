export interface DomainRevalidateState {
  defaultLocale: string | undefined;
  generation: number;
  locale: string | undefined;
  reason: "build" | "on-demand" | "stale" | undefined;
}

const state: DomainRevalidateState = {
  defaultLocale: undefined,
  generation: 0,
  locale: undefined,
  reason: undefined,
};

export function recordDomainRevalidateContext(
  context: Omit<DomainRevalidateState, "generation">,
): DomainRevalidateState {
  Object.assign(state, context, { generation: state.generation + 1 });
  return { ...state };
}

export function getDomainRevalidateState(): DomainRevalidateState {
  return { ...state };
}
