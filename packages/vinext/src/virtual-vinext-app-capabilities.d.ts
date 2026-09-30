declare module "virtual:vinext-app-capabilities" {
  export const serverActionClient:
    | typeof import("./server/app-browser-server-action-client.js")
    | null;
}
