import type { hydrateRoot, ReactFormState } from "react-dom/client";

type HydrateRootOptions = NonNullable<Parameters<typeof hydrateRoot>[2]>;
type HydrateRootCaughtErrorHandler = NonNullable<HydrateRootOptions["onCaughtError"]>;
type HydrateRootUncaughtErrorHandler = NonNullable<HydrateRootOptions["onUncaughtError"]>;

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
  onUncaughtError: HydrateRootUncaughtErrorHandler;
}): HydrateRootOptions {
  const hydrateOptions = {
    formState: options.formState,
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
