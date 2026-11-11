export const dynamic = "force-dynamic";

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

// A cached fetch's request changed right after fetch is called must be sent,
// and keyed, as it was when fetch was called.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const caseId = searchParams.get("case");
  const user = searchParams.get("user") ?? "";
  const target = new URL("/api/fetch-cache-changed-request/origin", request.url);
  target.searchParams.set("case", caseId ?? "");
  const next = { revalidate: 60 };

  let response: Promise<Response>;
  let change: () => void;
  switch (searchParams.get("input")) {
    case "url": {
      target.searchParams.set("user", user);
      response = fetch(target, { next });
      change = () => target.searchParams.set("user", "bobby");
      break;
    }
    case "headers": {
      const headers = new Headers({ "x-user": user });
      response = fetch(target, { headers, next });
      change = () => headers.set("x-user", "bobby");
      break;
    }
    case "request-headers": {
      const input = new Request(target, { headers: { "x-user": user } });
      response = fetch(input, { next });
      change = () => input.headers.set("x-user", "bobby");
      break;
    }
    default: {
      const body = encode({ user });
      response = fetch(target, { method: "POST", body, next });
      change = () => body.set(encode({ user: "bobby" }));
    }
  }
  if (searchParams.has("change")) change();
  return Response.json(await (await response).json());
}
