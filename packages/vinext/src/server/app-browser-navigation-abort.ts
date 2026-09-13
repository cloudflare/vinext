export type AppBrowserNavigationAbortHandle = {
  release(): void;
  signal: AbortSignal;
};

/**
 * Owns cancellation only while a navigation still has abortable transport work.
 * Once a Flight response is handed to React, release the handle so a newer
 * navigation does not abort the response body while React is decoding it.
 */
export function createAppBrowserNavigationAbortCoordinator(): {
  abortActive(): void;
  begin(): AppBrowserNavigationAbortHandle;
} {
  let activeController: AbortController | null = null;

  const abortActive = () => {
    activeController?.abort();
    activeController = null;
  };

  return {
    abortActive,
    begin() {
      abortActive();
      const controller = new AbortController();
      activeController = controller;
      return {
        release() {
          if (activeController === controller) {
            activeController = null;
          }
        },
        signal: controller.signal,
      };
    },
  };
}
