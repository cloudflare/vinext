import type { ImageOptimizer } from "vinext/server/image-optimization";

export default function createImageTestOptimizer(): ImageOptimizer {
  return {
    async transformImage(body, options) {
      await new Response(body).arrayBuffer();
      if (options.quality === 90) {
        return new Response(`format:${options.format}`, {
          headers: { "content-type": options.format },
        });
      }
      throw new Error("intentional image transform failure");
    },
  };
}
