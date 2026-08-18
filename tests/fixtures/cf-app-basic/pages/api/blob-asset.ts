export const config = { runtime: "edge" };

export default async function handler(): Promise<Response> {
  const asset = new URL("../../assets/blob-asset.txt", import.meta.url);
  const response = await fetch(asset);
  const headers = new Headers(response.headers);
  headers.set("x-vinext-asset-protocol", asset.protocol);
  headers.set("x-vinext-asset-pathname", asset.pathname);
  return new Response(response.body, { status: response.status, headers });
}
