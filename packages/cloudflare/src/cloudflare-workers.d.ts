declare module "cloudflare:workers" {
  /** Runtime base class supplied by Cloudflare Workers for named entrypoints. */
  export abstract class WorkerEntrypoint<Env = unknown, Props = unknown> {
    protected ctx: {
      readonly cache?: unknown;
      readonly props: Props;
      waitUntil(promise: Promise<unknown>): void;
    };
    protected env: Env;
    constructor(ctx: unknown, env: Env);
    fetch?(request: Request): Response | Promise<Response>;
  }
}
