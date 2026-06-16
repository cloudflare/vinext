declare module "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge" {
  export function renderToReadableStream(
    data: unknown,
    manifest: unknown,
    options?: unknown,
  ): ReadableStream<Uint8Array>;
  export function decodeReply(
    body: string | FormData,
    manifest: unknown,
    options?: unknown,
  ): Promise<unknown[]>;
  export function decodeAction(body: FormData, manifest: unknown): Promise<() => Promise<void>>;
  export function decodeFormState(
    actionResult: unknown,
    body: FormData,
    manifest: unknown,
  ): Promise<unknown>;
  export function createTemporaryReferenceSet(): unknown;
  export function registerClientReference<T>(proxy: T, id: string, name: string): T;
  export function registerServerReference<T>(reference: T, id: string, name: string): T;
}

declare module "virtual:vite-rsc/server-references" {
  const serverReferences: Record<string, (() => Promise<unknown>) | undefined>;
  export default serverReferences;
}
