import { fileURLToPath } from "node:url";

export function httpStageCacheAdapter() {
  const requestEntry = fileURLToPath(new URL("./http-stage-request.ts", import.meta.url));
  const responseEntry = fileURLToPath(new URL("./http-stage-response.ts", import.meta.url));
  return {
    adapter: fileURLToPath(new URL("./http-stage-cache.runtime.ts", import.meta.url)),
    output: {
      entries: { request: requestEntry, response: responseEntry },
      entry: requestEntry,
      matchesBuild({ plugins }: { plugins: readonly { name?: string }[] }) {
        return plugins.some(({ name }) => name === "independent-http-stage-host");
      },
      type: "multi-stage" as const,
    },
  };
}
