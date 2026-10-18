import { expect, test, type APIRequestContext } from "@playwright/test";

// Next.js passes a cached component's children as temporary references: the
// entry stores a reference, and a hit renders the current request's children.
// Covers Cache Components in workerd; app-router-prod/use-cache.spec.ts covers
// the Node production server.
const SECRETS = ["ALICE_PRIVATE_SECRET", "BOB_PRIVATE_SECRET", "PUBLIC_GUEST"];

async function visit(request: APIRequestContext, partition: string, session?: string) {
  const response = await request.get(
    `/use-cache-passthrough-children?partition=${partition}`,
    session ? { headers: { Cookie: `session=${session}` } } : {},
  );
  expect(response.status()).toBe(200);
  const html = await response.text();
  const text = (id: string) => html.match(new RegExp(`id="${id}">([^<]*)<`))?.[1];
  const result = {
    viewer: text("viewer"),
    secret: text("secret"),
    wrapper: text("wrapper-generated"),
  };
  expect(result.wrapper).toMatch(/^[0-9a-f-]{36}$/);
  // Covers the inline Flight payload as well as the HTML.
  for (const secret of SECRETS) {
    if (secret !== result.secret) expect(html).not.toContain(secret);
  }
  return result;
}

test("does not replay an authenticated visitor's children to later visitors", async ({
  request,
}) => {
  const partition = `alice-first-${Date.now()}`;
  const alice = await visit(request, partition, "alice");
  expect(alice).toMatchObject({ viewer: "alice", secret: "ALICE_PRIVATE_SECRET" });

  expect(await visit(request, partition)).toEqual({
    viewer: "guest",
    secret: "PUBLIC_GUEST",
    wrapper: alice.wrapper,
  });
  expect(await visit(request, partition, "bob")).toEqual({
    viewer: "bob",
    secret: "BOB_PRIVATE_SECRET",
    wrapper: alice.wrapper,
  });
});

test("does not replay a guest's children to a later authenticated visitor", async ({ request }) => {
  const partition = `guest-first-${Date.now()}`;
  const guest = await visit(request, partition);
  expect(guest).toMatchObject({ viewer: "guest", secret: "PUBLIC_GUEST" });

  expect(await visit(request, partition, "alice")).toEqual({
    viewer: "alice",
    secret: "ALICE_PRIVATE_SECRET",
    wrapper: guest.wrapper,
  });
});
