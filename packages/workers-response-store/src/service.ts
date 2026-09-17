import { CacheMetadata } from "./metadata-do";
import {
  ResponseStoreAdmin,
  ResponseStoreBinding,
  ResponseStoreService,
  type WorkersResponseStoreEnv,
} from "./binding";

export { CacheMetadata, ResponseStoreAdmin, ResponseStoreBinding, ResponseStoreService };

export default {
  fetch(): Response {
    return new Response("Use the ResponseStoreService service binding entrypoint.", {
      status: 404,
    });
  },
} satisfies ExportedHandler<WorkersResponseStoreEnv>;
