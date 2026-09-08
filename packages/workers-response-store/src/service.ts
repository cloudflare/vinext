import { CacheMetadata } from "./metadata-do";
import {
  ResponseStoreBinding,
  ResponseStoreService,
  type WorkersResponseStoreEnv,
} from "./binding";

export { CacheMetadata, ResponseStoreBinding, ResponseStoreService };

export default {
  fetch(): Response {
    return Response.json({
      name: "workers-response-store-service",
      status: "ready",
      backing: ["Workers Cache", "R2", "SQLite Durable Object"],
    });
  },
} satisfies ExportedHandler<WorkersResponseStoreEnv>;
