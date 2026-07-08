import { createRequire } from "node:module";
import path from "pathslash";
import { PassThrough, type Duplex as NodeDuplex, type Readable as NodeReadable } from "node:stream";
import type { ReactNode } from "react";
import type { PipeableStream, RenderToPipeableStreamOptions } from "react-dom/server";

type ReactDomServerNode = Pick<
  typeof import("react-dom/server"),
  "renderToPipeableStream" | "renderToStaticMarkup"
>;
type ReactDomStaticNode = Pick<typeof import("react-dom/static"), "prerenderToNodeStream">;

export type NodeFizzRenderOptions = RenderToPipeableStreamOptions & {
  maxHeadersLength?: number;
};

const nodeRequire = createRequire(import.meta.url);
const cwdRequire = createRequire(path.join(process.cwd(), "package.json"));
let reactDomServerNode: ReactDomServerNode | undefined;
let reactDomStaticNode: ReactDomStaticNode | undefined;

function isModuleNotFoundForSpecifier(error: unknown, specifier: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "MODULE_NOT_FOUND" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.includes(`'${specifier}'`)
  );
}

function requireRuntimeDependency<T>(specifier: string): T {
  try {
    return nodeRequire(specifier) as T;
  } catch (error) {
    if (!isModuleNotFoundForSpecifier(error, specifier)) {
      throw error;
    }
    return cwdRequire(specifier) as T;
  }
}

function isReactDevelopmentBuild(): boolean {
  const reactWithInternals = requireRuntimeDependency<typeof import("react")>(
    "react",
  ) as typeof import("react") & {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE?: unknown;
  };
  const internals =
    reactWithInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  return typeof internals === "object" && internals !== null && "actQueue" in internals;
}

function loadWithReactNodeEnv<T>(load: () => T): T {
  const expectedNodeEnv = isReactDevelopmentBuild() ? "development" : "production";
  const previousNodeEnv = process.env.NODE_ENV;

  // React DOM chooses its dev/prod implementation at require time. In-process
  // production builds can already have React's dev build cached by the test
  // runner, so load the Node renderer in the same mode as that React instance.
  if (previousNodeEnv !== expectedNodeEnv) {
    process.env.NODE_ENV = expectedNodeEnv;
  }

  try {
    return load();
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
}

function getReactDomServerNode(): ReactDomServerNode {
  reactDomServerNode ??= loadWithReactNodeEnv<ReactDomServerNode>(() =>
    requireRuntimeDependency<ReactDomServerNode>("react-dom/server.node"),
  );
  return reactDomServerNode;
}

function getReactDomStaticNode(): ReactDomStaticNode {
  reactDomStaticNode ??= loadWithReactNodeEnv<ReactDomStaticNode>(() =>
    requireRuntimeDependency<ReactDomStaticNode>("react-dom/static.node"),
  );
  return reactDomStaticNode;
}

function waitAtLeastOneReactRenderTask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

export function abortReactWorkWhenConsumerCloses(
  destination: NodeDuplex,
  getPipeable: () => PipeableStream | null,
): void {
  let completed = false;
  let aborted = false;

  const markCompleted = () => {
    completed = true;
  };
  const abort = () => {
    if (completed || aborted) return;
    aborted = true;
    getPipeable()?.abort();
  };

  destination.once("end", markCompleted);
  destination.once("finish", markCompleted);
  destination.once("error", abort);
  destination.once("close", () => {
    if (!completed && !destination.readableEnded) {
      abort();
    }
  });
}

export function renderToNodeStaticMarkup(element: ReactNode): string {
  return getReactDomServerNode().renderToStaticMarkup(element);
}

export function prerenderToNodeFizzStream(
  element: ReactNode,
  options: Parameters<ReactDomStaticNode["prerenderToNodeStream"]>[1],
): ReturnType<ReactDomStaticNode["prerenderToNodeStream"]> {
  return getReactDomStaticNode().prerenderToNodeStream(element, options);
}

export async function renderToNodeFizzStream(
  element: ReactNode,
  renderOptions: NodeFizzRenderOptions = {},
  options: { waitForAllReady?: boolean } = {},
): Promise<NodeReadable> {
  const destination = new PassThrough();
  const shellReady = createDeferred<void>();
  const allReady = createDeferred<void>();
  const waitForAllReady = options.waitForAllReady === true;
  const onError = renderOptions.onError;
  let pipeable: PipeableStream | null = null;
  let pipeWhenCreated = false;

  abortReactWorkWhenConsumerCloses(destination, () => pipeable);

  pipeable = getReactDomServerNode().renderToPipeableStream(element, {
    ...renderOptions,
    onShellReady() {
      shellReady.resolve();
    },
    onShellError(error) {
      shellReady.reject(error);
      if (waitForAllReady) {
        allReady.reject(error);
      }
    },
    onAllReady() {
      if (waitForAllReady) {
        if (pipeable) {
          pipeable.pipe(destination);
        } else {
          pipeWhenCreated = true;
        }
      }
      allReady.resolve();
    },
    onError(error, errorInfo) {
      return onError?.(error, errorInfo);
    },
  });

  if (pipeWhenCreated) {
    pipeable.pipe(destination);
  }

  if (waitForAllReady) {
    await Promise.all([shellReady.promise, allReady.promise]);
  } else {
    await shellReady.promise;
    await waitAtLeastOneReactRenderTask();
    pipeable.pipe(destination);
  }

  return destination;
}
