// Keep this adapter fixture-local and dependency-free: isolated Pages fixture
// copies do not necessarily include the source package's type-only exports.
export default function createImageTestOptimizer() {
  return {
    async transformImage(body: ReadableStream, options: { format: string; quality: number }) {
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
