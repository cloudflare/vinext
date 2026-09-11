import { exports as workerExports, WorkerEntrypoint } from "cloudflare:workers";

import {
  getWorkersResponseStore,
  ResponseStoreBinding,
  type RevalidationInput,
  type RevalidationService,
  type ResponseStoreServiceBinding,
  type ResponseStoreServiceInvocation,
  type WorkersResponseStoreEnv,
  type WorkersResponseStore,
} from "./binding";
import { CacheMetadata } from "./metadata-do";

export type ResponseStoreRevalidationContext<Env> = {
  env: Env;
  ctx: ExecutionContext;
};

export type ResponseStoreRevalidatorEntrypoint<Env = WorkersResponseStoreEnv> = new (
  ctx: ExecutionContext,
  env: Env,
) => WorkerEntrypoint<Env> & RevalidationService;

type WorkersResponseStoreDefinition<Env extends WorkersResponseStoreEnv = WorkersResponseStoreEnv> =
  WorkersResponseStore & {
    entrypoints: {
      CacheMetadata: typeof CacheMetadata;
      ResponseStoreRevalidator: ResponseStoreRevalidatorEntrypoint<Env>;
      ResponseStoreBinding: typeof ResponseStoreBinding;
    };
  };

type WorkersResponseStoreClientDefinition<Env> = WorkersResponseStore & {
  entrypoints: {
    ResponseStoreRevalidator: ResponseStoreRevalidatorEntrypoint<Env>;
    ResponseStoreClient: new (
      ctx: ExecutionContext,
      env: Env,
    ) => WorkerEntrypoint<Env> & WorkersResponseStore;
  };
};

export type ResponseStoreClientEntrypoint<Env = WorkersResponseStoreClientEnv> = new (
  ctx: ExecutionContext,
  env: Env,
) => WorkerEntrypoint<Env> & WorkersResponseStore;

export type WorkersResponseStoreOptions<Env> = {
  regenerate(
    input: RevalidationInput,
    context: ResponseStoreRevalidationContext<Env>,
  ): Response | Promise<Response>;
};

function createRevalidatorEntrypoint<Env>(options: WorkersResponseStoreOptions<Env>) {
  return class ResponseStoreRevalidator extends WorkerEntrypoint<Env> {
    async regenerate(input: RevalidationInput): Promise<Response> {
      return options.regenerate(input, { env: this.env, ctx: this.ctx });
    }
  };
}

function createStoreFacade(getStore: () => WorkersResponseStore): WorkersResponseStore {
  return {
    fetch: (request) => getStore().fetch(request),
    getTagExpiration: (tags, newerThan) => getStore().getTagExpiration(tags, newerThan),
    put: (request, response, options) => getStore().put(request, response, options),
    refresh: (options) => getStore().refresh(options),
    purge: (options) => getStore().purge(options),
  };
}

export function createWorkersResponseStore<
  Env extends WorkersResponseStoreEnv = WorkersResponseStoreEnv,
>(options: WorkersResponseStoreOptions<Env>): WorkersResponseStoreDefinition<Env> {
  const ResponseStoreRevalidator = createRevalidatorEntrypoint(options);

  const getStore = () => getWorkersResponseStore({ exports: workerExports });

  return {
    entrypoints: { CacheMetadata, ResponseStoreRevalidator, ResponseStoreBinding },
    ...createStoreFacade(getStore),
  };
}

export type WorkersResponseStoreClientEnv = {
  // Wrangler cannot infer the RPC methods of an entrypoint in another Worker,
  // so generated Env types expose named-entrypoint bindings as plain Service.
  RESPONSE_STORE: Service;
  CF_VERSION_METADATA: WorkerVersionMetadata;
};

export function createWorkersResponseStoreClient<
  Env extends WorkersResponseStoreClientEnv = WorkersResponseStoreClientEnv,
>(options: WorkersResponseStoreOptions<Env>): WorkersResponseStoreClientDefinition<Env> {
  const ResponseStoreRevalidator = createRevalidatorEntrypoint(options);

  class ResponseStoreClient extends WorkerEntrypoint<Env> implements WorkersResponseStore {
    private get service(): ResponseStoreServiceBinding {
      return this.env.RESPONSE_STORE as Service & ResponseStoreServiceBinding;
    }

    private getInvocation(): ResponseStoreServiceInvocation {
      const factory = Reflect.get(this.ctx.exports, "ResponseStoreRevalidator") as
        | (RevalidationService &
            ((options: { props: Record<string, never> }) => RevalidationService))
        | undefined;
      if (typeof factory !== "function") {
        throw new Error("The ResponseStoreRevalidator entrypoint is not exported");
      }

      const versionId = this.env.CF_VERSION_METADATA.id;
      if (!versionId) {
        throw new Error("Workers Response Store requires the user Worker version ID");
      }

      return {
        versionId,
        revalidator: factory({ props: {} }),
      };
    }

    fetch(request: Request): Promise<Response> {
      return this.service.read(request, this.getInvocation());
    }

    getTagExpiration(tags: string[], newerThan?: number): Promise<number> {
      return this.service.getTagExpiration(tags, this.getInvocation(), newerThan);
    }

    put(
      request: Request,
      response: Response,
      putOptions: Parameters<WorkersResponseStore["put"]>[2] = {},
    ): ReturnType<WorkersResponseStore["put"]> {
      return this.service.put(request, response, putOptions, this.getInvocation());
    }

    refresh(
      refreshOptions: Parameters<WorkersResponseStore["refresh"]>[0],
    ): ReturnType<WorkersResponseStore["refresh"]> {
      return this.service.refresh(refreshOptions, this.getInvocation());
    }

    purge(
      purgeOptions: Parameters<WorkersResponseStore["purge"]>[0],
    ): ReturnType<WorkersResponseStore["purge"]> {
      return this.service.purge(purgeOptions, this.getInvocation());
    }
  }

  const getClient = () => {
    const factory = Reflect.get(workerExports, "ResponseStoreClient") as
      | (WorkersResponseStore &
          ((options: { props: Record<string, never> }) => WorkersResponseStore))
      | undefined;
    if (typeof factory !== "function") {
      throw new Error("The ResponseStoreClient entrypoint is not exported");
    }
    return factory({ props: {} });
  };

  return {
    entrypoints: { ResponseStoreRevalidator, ResponseStoreClient },
    ...createStoreFacade(getClient),
  };
}

export type {
  ResponseStoreMutationResult,
  ResponseStorePurgeOptions,
  ResponseStorePutOptions,
  ResponseStoreRefreshOptions,
  RevalidationInput,
  RevalidationReason,
  SerializableValue,
  WorkersResponseStoreEnv,
  WorkersResponseStore,
} from "./binding";
