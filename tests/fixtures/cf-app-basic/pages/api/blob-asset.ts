export const config = { runtime: "edge" };

export default function handler(): Promise<Response> {
  const asset = new URL("../../assets/blob-asset.txt", import.meta.url);
  return fetch(asset);
}
