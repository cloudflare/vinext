type ServerActionClient = typeof import("./app-browser-server-action-client.js");

/**
 * Load the lazy Server Action client chunk. A tab opened before a deploy can
 * 404 on it, and the browser caches the failed import, so reload the document
 * instead of leaving every later action broken.
 */
export async function loadServerActionClientOrReload(
  load: () => Promise<ServerActionClient>,
  reload: () => boolean,
): Promise<ServerActionClient> {
  try {
    return await load();
  } catch (error) {
    if (!reload()) throw error;
    // The document is reloading; leave the action unresolved.
    return { invokeClientServerAction: async () => undefined } as unknown as ServerActionClient;
  }
}
