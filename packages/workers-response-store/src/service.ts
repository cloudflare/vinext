import { CacheMetadata } from "./metadata-do";
import {
  ResponseStoreBinding,
  ResponseStoreService,
  type WorkersResponseStoreEnv,
} from "./binding";

export { CacheMetadata, ResponseStoreBinding, ResponseStoreService };

export default {
  fetch(): Response {
    return new Response("Use the ResponseStoreService service binding entrypoint.", {
      status: 404,
    });
  },
} satisfies ExportedHandler<WorkersResponseStoreEnv>;
