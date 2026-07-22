import type { hydrateRoot, ReactFormState } from "react-dom/client";

type HydrateRootOptions = NonNullable<Parameters<typeof hydrateRoot>[2]>;
type HydrateRoot = typeof hydrateRoot;
type HydrateRootContainer = Parameters<HydrateRoot>[0];
type HydrateRootChildren = Parameters<HydrateRoot>[1];
type HydrateRootReturn = ReturnType<HydrateRoot>;
type HydrateRootCaughtErrorHandler = NonNullable<HydrateRootOptions["onCaughtError"]>;
type HydrateRootUncaughtErrorHandler = NonNullable<HydrateRootOptions["onUncaughtError"]>;
type HydrateRootRecoverableErrorHandler = NonNullable<HydrateRootOptions["onRecoverableError"]>;
type StartTransition = (action: () => void) => void;

export const RSC_FORM_STATE_GLOBAL = "__VINEXT_RSC_FORM_STATE__";

type FormStateGlobal = {
  [RSC_FORM_STATE_GLOBAL]?: ReactFormState;
};

export function consumeInitialFormState(global: FormStateGlobal): ReactFormState | null {
  const formState = global[RSC_FORM_STATE_GLOBAL] ?? null;
  delete global[RSC_FORM_STATE_GLOBAL];
  return formState;
}

export function createVinextHydrateRootOptions(options: {
  formState: ReactFormState | null;
  onCaughtError?: HydrateRootCaughtErrorHandler;
  onRecoverableError?: HydrateRootRecoverableErrorHandler;
  onUncaughtError: HydrateRootUncaughtErrorHandler;
}): HydrateRootOptions {
  const hydrateOptions = {
    formState: options.formState,
    ...(options.onRecoverableError ? { onRecoverableError: options.onRecoverableError } : {}),
    onUncaughtError: options.onUncaughtError,
  };

  if (options.onCaughtError) {
    return {
      ...hydrateOptions,
      onCaughtError: options.onCaughtError,
    };
  }

  return hydrateOptions;
}

export function hydrateRootInTransition(options: {
  children: HydrateRootChildren;
  container: HydrateRootContainer;
  hydrateRoot: HydrateRoot;
  options: HydrateRootOptions;
  startTransition: StartTransition;
}): HydrateRootReturn {
  let root: HydrateRootReturn | undefined;

  options.startTransition(() => {
    root = options.hydrateRoot(options.container, options.children, options.options);
  });

  if (root === undefined) {
    throw new Error("[vinext] React.startTransition did not synchronously start hydration");
  }

  return root;
}
