export default function createImageTestOptimizer() {
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
