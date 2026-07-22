type ActionDiscardingGlobal = typeof globalThis & {
  __vinextActionDiscardingState?: {
    value: number;
  };
};

const actionDiscardingGlobal: ActionDiscardingGlobal = globalThis;
const state = (actionDiscardingGlobal.__vinextActionDiscardingState ??= { value: 0 });

export function getValue(): number {
  return state.value;
}

export function incrementValue(): number {
  state.value += 1;
  return state.value;
}
