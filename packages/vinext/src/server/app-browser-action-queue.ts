type BrowserActionExecution<T> = {
  completion: Promise<unknown>;
  value: Promise<T>;
};

type QueuedAction = {
  next: QueuedAction | null;
  run(): BrowserActionExecution<unknown>;
};

export type AppBrowserActionQueue = {
  enqueue<T>(run: () => BrowserActionExecution<T>): Promise<T>;
  runNavigation<T>(run: () => Promise<T>): Promise<T>;
  runQueuedNavigation<T>(run: () => Promise<T>): Promise<T>;
};

export function createAppBrowserActionQueue(): AppBrowserActionQueue {
  let active: QueuedAction | null = null;
  let last: QueuedAction | null = null;

  function runAction(action: QueuedAction): void {
    active = action;
    const execution = action.run();
    void execution.completion.then(
      () => advance(action),
      () => advance(action),
    );
  }

  function advance(completed: QueuedAction): void {
    if (active !== completed) return;
    active = completed.next;
    if (active === null) {
      last = null;
      return;
    }
    runAction(active);
  }

  function enqueue<T>(run: () => BrowserActionExecution<T>): Promise<T> {
    let resolveValue!: (value: T | PromiseLike<T>) => void;
    let rejectValue!: (reason?: unknown) => void;
    const value = new Promise<T>((resolve, reject) => {
      resolveValue = resolve;
      rejectValue = reject;
    });
    const action: QueuedAction = {
      next: null,
      run() {
        const execution = run();
        execution.value.then(resolveValue, rejectValue);
        return execution;
      },
    };

    if (active === null) {
      last = action;
      runAction(action);
    } else {
      if (last !== null) last.next = action;
      last = action;
    }
    return value;
  }

  return {
    enqueue,
    runNavigation<T>(run: () => Promise<T>): Promise<T> {
      const pendingActions = active?.next ?? null;
      const navigation = run();
      const navigationAction: QueuedAction = {
        next: pendingActions,
        run: () => ({ completion: navigation, value: navigation }),
      };
      active = navigationAction;
      if (pendingActions === null) last = navigationAction;
      void navigation.then(
        () => advance(navigationAction),
        () => advance(navigationAction),
      );
      return navigation;
    },
    runQueuedNavigation<T>(run: () => Promise<T>): Promise<T> {
      return enqueue(() => {
        const navigation = run();
        return { completion: navigation, value: navigation };
      });
    },
  };
}
