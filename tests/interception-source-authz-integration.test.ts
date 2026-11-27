import fs from "node:fs/promises";
import path from "node:path";
import { createBuilder } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import vinext from "../packages/vinext/src/index.js";
import { createIsolatedFixture, startFixtureServer } from "./helpers.js";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "./fixtures/interception-source-authz");
const GUARDED_MARKER = "SECRET-FEED-CONTENT";
const GUARDED_OWNER_MARKER = "SECRET-VAULT-CONTENT";
const GUARDED_MEMBER_MARKER = "SECRET-MEMBER-CONTENT";
const GUARDED_NOTE_MARKER = "SECRET-NOTE-CONTENT";
const GUARDED_VIEWER_MARKER = "SECRET-VIEWER-CONTENT";
const GUARDED_GALLERY_MARKER = "SECRET-GALLERY-CONTENT";
const GUARDED_TEAM_MARKER = "SECRET-TEAM-CONTENT";

type StartedServer = {
  baseUrl: string;
  close(): Promise<void>;
};

function interceptionHeaders(source: string): Record<string, string> {
  return {
    Accept: "text/x-component",
    RSC: "1",
    "X-Vinext-Interception-Context": source,
  };
}

// The ids an RSC payload leaves for the client to keep, read from its Flight
// rows rather than decoded.
function retainedElementIds(flight: string): string[] {
  const list = flight.match(/"__retainedElementIds":(\[[^\]]*\])/)?.[1];
  return list ? (JSON.parse(list) as string[]) : [];
}

function forgedActionRequest(
  baseUrl: string,
  actionId: string,
  source: string,
  extraHeaders: Record<string, string> = {},
): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=UTF-8",
      "Next-Action": actionId,
      Origin: baseUrl,
      "X-Vinext-Interception-Context": source,
      ...extraHeaders,
    },
    body: "[]",
  };
}

async function readPhotoActionId(baseUrl: string): Promise<string> {
  const html = await (await fetch(`${baseUrl}/photos/1`)).text();
  const actionId = html.match(/name="\$ACTION_ID_([^"]+)"/)?.[1];
  if (!actionId) throw new Error("Photo page did not render its server action form");
  return actionId;
}

async function startDevServer(root: string): Promise<StartedServer> {
  const { server, baseUrl } = await startFixtureServer(root, { appRouter: true });
  return {
    baseUrl,
    close: () => server.close(),
  };
}

async function startProductionServer(root: string): Promise<StartedServer> {
  const builder = await createBuilder({
    root,
    configFile: false,
    plugins: [vinext({ appDir: root })],
    logLevel: "silent",
  });
  await builder.buildApp();

  const { startProdServer } = await import("../packages/vinext/src/server/prod-server.js");
  const { server } = await startProdServer({
    host: "127.0.0.1",
    port: 0,
    outDir: path.join(root, "dist"),
    noCompression: true,
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Production server did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function expectInterceptionSourceAuthorization(baseUrl: string): Promise<void> {
  const direct = await fetch(`${baseUrl}/feed/secret`);
  expect(direct.status).toBe(403);
  expect(direct.headers.get("x-auth-guard")).toBe("blocked");
  expect(await direct.text()).not.toContain(GUARDED_MARKER);

  const control = await fetch(`${baseUrl}/photos/1`, {
    headers: interceptionHeaders("/feed/secret"),
  });
  expect(control.status).toBe(403);
  expect(control.headers.get("x-auth-guard")).toBe("blocked");
  expect(await control.text()).not.toContain(GUARDED_MARKER);

  // Next.js never rejects a request over its `Next-Url`, so a context that
  // names no canonical source is treated as absent and the target renders on
  // its own.
  const traversal = await fetch(`${baseUrl}/photos/1`, {
    headers: interceptionHeaders("/feed/.."),
  });
  const traversalBody = await traversal.text();
  expect({
    status: traversal.status,
    authGuard: traversal.headers.get("x-auth-guard"),
    cacheControl: traversal.headers.get("cache-control"),
    rendersTarget: traversalBody.includes("Refresh"),
    exposedGuardedContent: traversalBody.includes(GUARDED_MARKER),
  }).toEqual({
    status: 200,
    authGuard: null,
    cacheControl: "private, no-cache, no-store, max-age=0, must-revalidate",
    rendersTarget: true,
    exposedGuardedContent: false,
  });

  // Static segments match the raw path, as in Next.js, so a direct request to
  // `/%66eed/secret` reaches no `/feed` route, and neither does the claimed
  // source: the target renders without interception.
  const encodedAlias = await fetch(`${baseUrl}/photos/1`, {
    headers: interceptionHeaders("/%66eed/secret"),
  });
  const encodedAliasBody = await encodedAlias.text();
  expect({
    status: encodedAlias.status,
    exposedGuardedContent: encodedAliasBody.includes(GUARDED_MARKER),
  }).toEqual({
    status: 200,
    exposedGuardedContent: false,
  });

  // `/vault` owns an interception slot and middleware guards only its exact
  // path. A source below it with no route of its own passes source middleware,
  // so it must not fall back to rendering the guarded owner page.
  const guardedOwner = await fetch(`${baseUrl}/photos/1`, {
    headers: interceptionHeaders("/vault"),
  });
  expect(guardedOwner.status).toBe(403);
  expect(await guardedOwner.text()).not.toContain(GUARDED_OWNER_MARKER);

  const missingDescendant = await fetch(`${baseUrl}/photos/1`, {
    headers: interceptionHeaders("/vault/missing"),
  });
  const missingDescendantBody = await missingDescendant.text();
  expect({
    status: missingDescendant.status,
    rendersPhoto:
      missingDescendantBody.includes("Refresh") ||
      missingDescendantBody.includes("VAULT-PHOTO-MODAL"),
    exposedGuardedOwner: missingDescendantBody.includes(GUARDED_OWNER_MARKER),
  }).toEqual({
    status: 200,
    rendersPhoto: true,
    exposedGuardedOwner: false,
  });

  // A server action rerenders the page it was posted to, intercepted tree
  // included, so a forged source context reaches the same render. The vinext
  // client always sends `RSC: 1` with action POSTs; that request must still
  // authorize the source, and one without it must not render the source at all.
  const actionId = await readPhotoActionId(baseUrl);
  const rscAction = await fetch(
    `${baseUrl}/photos/1`,
    forgedActionRequest(baseUrl, actionId, "/feed/secret", interceptionHeaders("/feed/secret")),
  );
  expect(rscAction.status).toBe(403);
  expect(rscAction.headers.get("x-auth-guard")).toBe("blocked");
  expect(await rscAction.text()).not.toContain(GUARDED_MARKER);

  const nonRscAction = await fetch(
    `${baseUrl}/photos/1`,
    forgedActionRequest(baseUrl, actionId, "/feed/secret"),
  );
  const nonRscActionBody = await nonRscAction.text();
  expect({
    status: nonRscAction.status,
    authGuard: nonRscAction.headers.get("x-auth-guard"),
    rendersTarget: nonRscActionBody.includes("Refresh"),
    exposedGuardedContent: nonRscActionBody.includes(GUARDED_MARKER),
  }).toEqual({
    status: 200,
    authGuard: null,
    rendersTarget: true,
    exposedGuardedContent: false,
  });
}

describe.each([
  ["development", startDevServer],
  ["production", startProductionServer],
] as const)("interception source authorization (%s)", (_mode, startServer) => {
  let fixtureRoot = "";
  let server: StartedServer | undefined;

  beforeAll(async () => {
    fixtureRoot = await createIsolatedFixture(FIXTURE_DIR, "vinext-interception-authz-");
    server = await startServer(fixtureRoot);
  }, 120_000);

  afterAll(async () => {
    await server?.close();
    if (fixtureRoot) await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  // Interception routes paired with middleware mirror the Next.js topology in:
  // https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/interception-dynamic-segment-middleware/interception-dynamic-segment-middleware.test.ts
  // The forged source-context request is vinext-specific. The fixture mirrors
  // the reported application and request boundary:
  // /photos/[id] is intercepted from /feed/@modal/(...)photos/[id], while
  // middleware guards /feed/:path* and /feed/[...rest] exposes a marker.
  // /vault owns the same intercept, and middleware guards only its exact path.
  it("does not authorize and render different interception source paths", async () => {
    if (!server) throw new Error("Interception authorization fixture server did not start");
    await expectInterceptionSourceAuthorization(server.baseUrl);
  }, 30_000);

  // next.config.mjs serves /login instead of /members/[id] from a plain-array
  // (afterFiles) rewrite unless the passcode cookie is present. A direct request
  // to a dynamic route takes afterFiles rules before the route is accepted, so
  // the same rule must refuse the member page as an interception source.
  it("applies afterFiles rewrites to a dynamic interception source", async () => {
    if (!server) throw new Error("Interception authorization fixture server did not start");
    const { baseUrl } = server;
    const passcode = { Cookie: "passcode=letmein" };

    const anonymousDirect = await fetch(`${baseUrl}/members/7`);
    const anonymousDirectBody = await anonymousDirect.text();
    expect(anonymousDirect.status).toBe(200);
    expect(anonymousDirectBody).toContain("LOGIN-PAGE");
    expect(anonymousDirectBody).not.toContain(GUARDED_MEMBER_MARKER);

    const memberDirect = await fetch(`${baseUrl}/members/7`, { headers: passcode });
    expect(memberDirect.status).toBe(200);
    expect(await memberDirect.text()).toContain(GUARDED_MEMBER_MARKER);

    // The anonymous client shows the login page the rule served, which does
    // not intercept the photo, so it navigates to the photo page itself.
    const anonymous = await fetch(`${baseUrl}/photos/1`, {
      headers: interceptionHeaders("/members/7"),
    });
    const anonymousBody = await anonymous.text();
    expect({
      status: anonymous.status,
      rendersPhoto: anonymousBody.includes("Refresh"),
      rendersModal: anonymousBody.includes("MEMBERS-PHOTO-MODAL"),
      exposedGuardedContent: anonymousBody.includes(GUARDED_MEMBER_MARKER),
      retainsSource: retainedElementIds(anonymousBody).includes("page:/members/7"),
    }).toEqual({
      status: 200,
      rendersPhoto: true,
      rendersModal: false,
      exposedGuardedContent: false,
      retainsSource: false,
    });

    // The client keeps the member page it shows beneath the modal, so the
    // intercepted payload names it rather than rendering it again.
    const member = await fetch(`${baseUrl}/photos/1`, {
      headers: { ...interceptionHeaders("/members/7"), ...passcode },
    });
    const memberBody = await member.text();
    expect({
      status: member.status,
      rendersSource: memberBody.includes(GUARDED_MEMBER_MARKER),
      rendersModal: memberBody.includes("MEMBERS-PHOTO-MODAL"),
      retainsSource: retainedElementIds(memberBody).includes("page:/members/7"),
    }).toEqual({
      status: 200,
      rendersSource: false,
      rendersModal: true,
      retainsSource: true,
    });
  }, 30_000);

  // middleware.ts gives every /photos request a trusted-viewer request header
  // and admits only trusted viewers to /viewers/[id]; /notes/[id] checks the
  // same header in its page. Neither may see the header a target's middleware
  // set: a direct request to the source never carries it.
  it("authorizes and renders an interception source without the target's request headers", async () => {
    if (!server) throw new Error("Interception authorization fixture server did not start");
    const { baseUrl } = server;
    const trusted = { "X-Trusted-Viewer": "1" };

    const direct = await fetch(`${baseUrl}/viewers/7`);
    expect(direct.status).toBe(403);
    expect(await direct.text()).not.toContain(GUARDED_VIEWER_MARKER);

    const intercepted = await fetch(`${baseUrl}/photos/1`, {
      headers: interceptionHeaders("/viewers/7"),
    });
    expect(intercepted.status).toBe(403);
    expect(intercepted.headers.get("x-auth-guard")).toBe("blocked");
    expect(await intercepted.text()).not.toContain(GUARDED_VIEWER_MARKER);

    const trustedDirect = await fetch(`${baseUrl}/viewers/7`, { headers: trusted });
    expect(trustedDirect.status).toBe(200);
    expect(await trustedDirect.text()).toContain(GUARDED_VIEWER_MARKER);

    const trustedIntercepted = await fetch(`${baseUrl}/photos/1`, {
      headers: { ...interceptionHeaders("/viewers/7"), ...trusted },
    });
    const trustedInterceptedBody = await trustedIntercepted.text();
    expect({
      status: trustedIntercepted.status,
      rendersSource: trustedInterceptedBody.includes(GUARDED_VIEWER_MARKER),
      rendersModal: trustedInterceptedBody.includes("VIEWERS-PHOTO-MODAL"),
      retainsSource: retainedElementIds(trustedInterceptedBody).includes("page:/viewers/7"),
    }).toEqual({
      status: 200,
      rendersSource: false,
      rendersModal: true,
      retainsSource: true,
    });

    const directNote = await fetch(`${baseUrl}/notes/7`);
    expect(directNote.status).toBe(200);
    const directNoteBody = await directNote.text();
    expect(directNoteBody).toContain("NOTE-LOCKED");
    expect(directNoteBody).not.toContain(GUARDED_NOTE_MARKER);

    const interceptedNote = await fetch(`${baseUrl}/photos/1`, {
      headers: interceptionHeaders("/notes/7"),
    });
    const interceptedNoteBody = await interceptedNote.text();
    expect({
      status: interceptedNote.status,
      rendersSource: interceptedNoteBody.includes(GUARDED_NOTE_MARKER),
      rendersModal: interceptedNoteBody.includes("NOTES-PHOTO-MODAL"),
      retainsSource: retainedElementIds(interceptedNoteBody).includes("page:/notes/7"),
    }).toEqual({
      status: 200,
      rendersSource: false,
      rendersModal: true,
      retainsSource: true,
    });
  }, 30_000);

  // Middleware blocks /gallery and /teams/[team] but not the pics beneath
  // them, which /gallery/@modal/(.)pics/[id] and /teams/[team]/@modal/(.)pics/[id]
  // intercept. An intercepted render shows the source page the client already
  // has and renders only the layouts above the slot, which a direct request to
  // the pic renders too, with the same team. The pic's own request authorizes
  // them, as in Next.js, which runs only the target's middleware. A source
  // whose team differs from the pic's would render a layout the pic's request
  // never did, so its own middleware still decides.
  it("renders an interception source's layouts under the target's request when the target renders them too", async () => {
    if (!server) throw new Error("Interception authorization fixture server did not start");
    const { baseUrl } = server;

    for (const source of ["/gallery", "/albums", "/teams/acme", "/teams/acme/nested"]) {
      const direct = await fetch(`${baseUrl}${source}`);
      expect(direct.status).toBe(403);
      expect(direct.headers.get("x-auth-guard")).toBe("blocked");
    }

    const gallery = await fetch(`${baseUrl}/gallery/pics/1`, {
      headers: interceptionHeaders("/gallery"),
    });
    const galleryBody = await gallery.text();
    expect({
      status: gallery.status,
      rendersSource:
        galleryBody.includes(GUARDED_GALLERY_MARKER) ||
        galleryBody.includes("SECRET-GALLERY-TITLE"),
      rendersLayout: galleryBody.includes("GALLERY-LAYOUT"),
      rendersModal: galleryBody.includes("GALLERY-PICS-MODAL"),
      retainsSource: retainedElementIds(galleryBody).includes("page:/gallery"),
    }).toEqual({
      status: 200,
      rendersSource: false,
      rendersLayout: true,
      rendersModal: true,
      retainsSource: true,
    });

    // A route group inside the slot adds no URL segment.
    const albums = await fetch(`${baseUrl}/albums/pics/1`, {
      headers: interceptionHeaders("/albums"),
    });
    const albumsBody = await albums.text();
    expect({
      status: albums.status,
      rendersSource: albumsBody.includes("SECRET-ALBUMS-CONTENT"),
      rendersModal: albumsBody.includes("ALBUMS-PICS-MODAL"),
    }).toEqual({ status: 200, rendersSource: false, rendersModal: true });

    const team = await fetch(`${baseUrl}/teams/acme/pics/1`, {
      headers: interceptionHeaders("/teams/acme"),
    });
    const teamBody = await team.text();
    expect({
      status: team.status,
      rendersSource: teamBody.includes(GUARDED_TEAM_MARKER),
      rendersLayout: teamBody.includes("TEAM-LAYOUT:acme"),
      rendersModal: teamBody.includes("TEAM-PICS-MODAL"),
      retainsSource: retainedElementIds(teamBody).includes("page:/teams/acme"),
    }).toEqual({
      status: 200,
      rendersSource: false,
      rendersLayout: true,
      rendersModal: true,
      retainsSource: true,
    });

    // A directory inside the slot belongs to the intercepting branch too.
    const nested = await fetch(`${baseUrl}/teams/acme/nested/pics/1`, {
      headers: interceptionHeaders("/teams/acme/nested"),
    });
    const nestedBody = await nested.text();
    expect({
      status: nested.status,
      rendersSource: nestedBody.includes("SECRET-TEAM-NESTED-CONTENT"),
      rendersLayout: nestedBody.includes("TEAM-LAYOUT:acme"),
      rendersModal: nestedBody.includes("TEAM-NESTED-PICS-MODAL"),
    }).toEqual({ status: 200, rendersSource: false, rendersLayout: true, rendersModal: true });
    const otherNested = await fetch(`${baseUrl}/teams/acme/nested/pics/1`, {
      headers: interceptionHeaders("/teams/other/nested"),
    });
    const otherNestedBody = await otherNested.text();
    expect({
      status: otherNested.status,
      rendersOtherTeam: otherNestedBody.includes("TEAM-LAYOUT:other"),
      exposedGuardedContent: otherNestedBody.includes("SECRET-TEAM-NESTED-CONTENT"),
    }).toEqual({ status: 403, rendersOtherTeam: false, exposedGuardedContent: false });

    const otherTeam = await fetch(`${baseUrl}/teams/acme/pics/1`, {
      headers: interceptionHeaders("/teams/other"),
    });
    const otherTeamBody = await otherTeam.text();
    expect({
      status: otherTeam.status,
      authGuard: otherTeam.headers.get("x-auth-guard"),
      rendersOtherTeam: otherTeamBody.includes("TEAM-LAYOUT:other"),
      exposedGuardedContent: otherTeamBody.includes(GUARDED_TEAM_MARKER),
    }).toEqual({
      status: 403,
      authGuard: "blocked",
      rendersOtherTeam: false,
      exposedGuardedContent: false,
    });

    // shelf/(.)item/[id] sits beside shelf/[slug], which has a layout of its
    // own, so an intercept from a shelf renders that shelf's layout and page.
    // A direct request to the item renders neither.
    const directShelf = await fetch(`${baseUrl}/shelf/secret`);
    expect(directShelf.status).toBe(403);
    const shelf = await fetch(`${baseUrl}/shelf/item/1`, {
      headers: interceptionHeaders("/shelf/secret"),
    });
    const shelfBody = await shelf.text();
    expect({
      status: shelf.status,
      authGuard: shelf.headers.get("x-auth-guard"),
      exposedGuardedContent: shelfBody.includes("SECRET-SHELF"),
    }).toEqual({
      status: 403,
      authGuard: "blocked",
      exposedGuardedContent: false,
    });
  }, 30_000);
});
