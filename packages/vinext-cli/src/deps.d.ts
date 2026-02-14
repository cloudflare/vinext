declare module "vinext/server/prod-server" {
  export function startProdServer(options?: {
    port?: number;
    host?: string;
    outDir?: string;
  }): Promise<import("node:http").Server>;
}
