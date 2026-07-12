declare module "virtual:vinext-app-capabilities" {
  type ServerActionClient = typeof import("./server/app-browser-server-action-client.js");

  export const hasServerActions: boolean;
  export const loadServerActionClient: (() => Promise<ServerActionClient>) | null;
}
