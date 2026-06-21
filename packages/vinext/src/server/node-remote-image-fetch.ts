import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { Readable } from "node:stream";

function addressFamily(address: string): 4 | 6 {
  return address.includes(":") ? 6 : 4;
}

export async function resolveRemoteImageHostnames(hostname: string): Promise<string[]> {
  return (await dnsLookup(hostname, { all: true })).map((entry) => entry.address);
}

export async function fetchRemoteImageFromValidatedAddresses(
  url: URL,
  addresses: readonly string[],
  signal: AbortSignal,
): Promise<Response> {
  if (addresses.length === 0) throw new Error("No validated remote image addresses");

  const request = url.protocol === "https:" ? requestHttps : requestHttp;
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const lookup = (
      _hostname: string,
      options: LookupOptions,
      callback: (
        error: NodeJS.ErrnoException | null,
        address: string | LookupAddress[],
        family?: number,
      ) => void,
    ) => {
      const approved = addresses.map((address) => ({ address, family: addressFamily(address) }));
      if ("all" in options && options.all) {
        callback(null, approved);
      } else {
        const preferred = approved.find(({ family }) => family === options.family) ?? approved[0];
        callback(null, preferred.address, preferred.family);
      }
    };

    const outgoing = request(url, {
      agent: false,
      headers: { Accept: "image/avif,image/webp,image/*,*/*;q=0.8" },
      lookup,
      signal,
    });
    outgoing.once("response", resolve);
    outgoing.once("error", reject);
    outgoing.end();
  });

  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }

  return new Response(Readable.toWeb(response) as ReadableStream, {
    status: response.statusCode ?? 500,
    statusText: response.statusMessage,
    headers,
  });
}
