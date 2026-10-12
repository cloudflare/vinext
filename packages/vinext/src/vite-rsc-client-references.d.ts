declare module "virtual:vite-rsc/client-references" {
  const clientReferences: Record<string, unknown>;
  export default clientReferences;
  /** Reference key of vinext's `DynamicPreloadChunks` shim, when the build has one. */
  export const dynamicPreloadChunksReferenceKey: string | undefined;
}
