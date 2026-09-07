import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import rsc from "@vitejs/plugin-rsc";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createBuilder } from "vite";
import vinext from "../packages/vinext/src/index.js";
import { RSC_ENTRIES } from "./helpers.js";

type BuiltHandler = (request: Request, context?: unknown) => Promise<Response>;

let fixtureRoot = "";
let handler: BuiltHandler;
let actionIds: Record<string, string>;
let builtSource = "";
let encryptionKey: CryptoKey;

async function write(relativePath: string, contents: string): Promise<void> {
  const filePath = path.join(fixtureRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

async function readBuiltJavaScript(directory: string): Promise<string> {
  let output = "";
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) output += await readBuiltJavaScript(entryPath);
    else if (entry.name.endsWith(".js")) output += await fs.readFile(entryPath, "utf8");
  }
  return output;
}

function findActionId(source: string, exportName: string): string {
  const escapedExportName = exportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(
    new RegExp(`["'\`]([0-9a-f]{12})["'\`]\\s*,\\s*["'\`]${escapedExportName}["'\`]`),
  );
  if (!match) throw new Error(`Missing built action id for ${exportName}`);
  return `${match[1]}#${exportName}`;
}

function findActionIds(source: string, exportName: string): string[] {
  const escapedExportName = exportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...source.matchAll(
      new RegExp(`["'\`]([0-9a-f]{12})["'\`]\\s*,\\s*["'\`]${escapedExportName}["'\`]`, "g"),
    ),
  ].map((match) => `${match[1]}#${exportName}`);
}

function actionRequest(pathname: string, actionId: string, args: unknown[]): Request {
  return new Request(`http://example.com${pathname}`, {
    body: JSON.stringify(args),
    headers: {
      "content-type": "text/plain;charset=UTF-8",
      host: "example.com",
      "next-action": actionId,
      origin: "http://example.com",
    },
    method: "POST",
  });
}

async function encryptBoundArgsFixture(serializedFlightValue: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    encryptionKey,
    new TextEncoder().encode(serializedFlightValue),
  );
  return Buffer.concat([Buffer.from(iv), Buffer.from(encrypted)]).toString("base64");
}

describe("production server action runtime security", () => {
  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vinext-action-runtime-security-"));
    await fs.symlink(path.resolve("node_modules"), path.join(fixtureRoot, "node_modules"));
    await write("package.json", '{"type":"module"}\n');
    await write(
      "middleware.ts",
      `import { NextResponse } from "next/server";
export function middleware(request) {
  if (request.nextUrl.pathname === "/admin/[id]") {
    return new NextResponse("dynamic worker denied", { status: 401 });
  }
  if (request.nextUrl.pathname === "/cookie-source") {
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-auth", "trusted");
    const response = NextResponse.next({ request: { headers } });
    response.cookies.set("forwarded-cookie", "present");
    return response;
  }
  if (request.nextUrl.pathname.startsWith("/admin")) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  if (request.nextUrl.pathname === "/client-owner") {
    return new NextResponse("client owner denied", { status: 401 });
  }
  if (request.nextUrl.pathname === "/loop") {
    return NextResponse.rewrite(new URL("/", request.url));
  }
  return NextResponse.next();
}
export const config = { matcher: ["/admin/:path*", "/client-owner", "/cookie-source", "/loop"] };
`,
    );
    await write(
      "app/layout.tsx",
      `export default function Layout({ children }) {
  return <html><body>{children}</body></html>;
}
`,
    );
    await write(
      "app/actions.ts",
      `'use server';
import { redirect } from "next/navigation";
export async function goTo(target) { redirect(target); }
`,
    );
    await write(
      "app/page.tsx",
      `import { goTo } from "./actions";
import { ImportedActionForm } from "./imported-action-form";
export default function Page() {
  return <><form action={goTo.bind(null, "/")}><button>home</button></form><ImportedActionForm /></>;
}
`,
    );
    await write(
      "app/imported-action-form.tsx",
      `export function ImportedActionForm() {
  const importedInlineAction = async () => { "use server"; return "IMPORTED_INLINE_ACTION_EXECUTED"; };
  return <form action={importedInlineAction}><button>imported</button></form>;
}
`,
    );
    await write(
      "app/admin/actions.ts",
      `'use server';
export async function deleteEverything() { return "ADMIN_ACTION_EXECUTED"; }
`,
    );
    await write(
      "app/client-owner/actions.ts",
      `'use server';
export async function clientOwnedAction() { return "CLIENT_OWNED_ACTION_EXECUTED"; }
`,
    );
    await write(
      "app/client-owner/button.tsx",
      `'use client';
import { clientOwnedAction } from "./actions";
export function ClientButton() {
  return <form action={clientOwnedAction}><button>client owner</button></form>;
}
`,
    );
    await write(
      "app/client-owner/page.tsx",
      `import { ClientButton } from "./button";
export default function Page() { return <ClientButton />; }
`,
    );
    await write(
      "app/admin/page.tsx",
      `import { deleteEverything } from "./actions";
export default function Page() {
  return <form action={deleteEverything}><button>delete</button></form>;
}
`,
    );
    await write(
      "app/shared-actions.ts",
      `'use server';
export async function publicOnly() { return "PUBLIC_ACTION_EXECUTED"; }
export async function adminOnly() { return "ADMIN_SHARED_ACTION_EXECUTED"; }
`,
    );
    await write(
      "app/shared/page.tsx",
      `import { publicOnly } from "../shared-actions";
export default function Page() { return <form action={publicOnly}><button>public</button></form>; }
`,
    );
    await write(
      "app/admin/shared/page.tsx",
      `import { adminOnly } from "../../shared-actions";
export default function Page() { return <form action={adminOnly}><button>admin</button></form>; }
`,
    );
    await write(
      "app/admin/[id]/page.tsx",
      `export default function Page() {
  const dynamicAdmin = async () => { "use server"; return "DYNAMIC_ADMIN_ACTION_EXECUTED"; };
  return <form action={dynamicAdmin}><button>dynamic</button></form>;
}
`,
    );
    await write(
      "app/loop/page.tsx",
      `export default function Page() {
  const loopAction = async () => { "use server"; return "LOOP_ACTION_EXECUTED"; };
  return <form action={loopAction}><button>loop</button></form>;
}
`,
    );
    await write(
      "app/cookie-owner/page.tsx",
      `import { cookies, headers } from "next/headers";
export default function Page() {
  const readForwardedCookie = async () => {
    "use server";
    return {
      auth: (await headers()).get("x-forwarded-auth"),
      cookie: (await cookies()).get("forwarded-cookie")?.value ?? "missing",
    };
  };
  return <form action={readForwardedCookie}><button>cookie</button></form>;
}
`,
    );
    await write(
      "app/admin/secret/page.tsx",
      `export default function Page() { return <div>ADMIN_SECRET_MARKER_42</div>; }
`,
    );
    await write(
      "app/oracle/page.tsx",
      `export default async function Page({ searchParams }) {
  const value = (await searchParams).value ?? "public";
  const oracle = async () => { "use server"; return "ORACLE:" + value; };
  return <form action={oracle}><button>oracle</button></form>;
}
`,
    );
    await write(
      "app/admin/replay/page.tsx",
      `import { redirect } from "next/navigation";
export default function Page() {
  const accountToDelete = "alice";
  const deleteAccount = async () => {
    "use server";
    redirect("/admin/secret?deleted=" + accountToDelete);
  };
  return <form action={deleteAccount}><button>delete</button></form>;
}
`,
    );

    const builder = await createBuilder({
      root: fixtureRoot,
      configFile: false,
      // Keep appDir implicit so this also verifies manual RSC helper plugins
      // follow a programmatic Vite root outside process.cwd().
      plugins: [vinext({ rsc: false }), rsc({ entries: RSC_ENTRIES })],
      logLevel: "silent",
    });
    await builder.buildApp();

    builtSource = await readBuiltJavaScript(path.join(fixtureRoot, "dist", "server"));
    actionIds = {
      clientOwnedAction: findActionId(builtSource, "clientOwnedAction"),
      deleteEverything: findActionId(builtSource, "deleteEverything"),
      goTo: findActionId(builtSource, "goTo"),
    };
    const encryptionKeySource = await fs.readFile(
      path.join(fixtureRoot, "dist", "server", "__vite_rsc_encryption_key.js"),
      "utf8",
    );
    const encryptionKeyBase64 = encryptionKeySource.match(
      /export default ["'`]([^"'`]+)["'`]/,
    )?.[1];
    if (!encryptionKeyBase64) throw new Error("Missing built RSC encryption key");
    encryptionKey = await crypto.subtle.importKey(
      "raw",
      Buffer.from(encryptionKeyBase64, "base64"),
      { name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"],
    );
    const module = await import(
      `${pathToFileURL(path.join(fixtureRoot, "dist", "server", "index.js")).href}?security`
    );
    handler = module.default as BuiltHandler;
  }, 120_000);

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("re-enters protected route middleware before dispatching an action from a public path", async () => {
    const direct = await handler(new Request("http://example.com/admin"));
    expect(direct.status).toBe(401);

    const response = await handler(actionRequest("/", actionIds.deleteEverything, []));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{}");
  });

  it("keeps offline-computable action ids harmless by enforcing route ownership", async () => {
    const normalizedActionPath = path.relative(
      fixtureRoot,
      await fs.realpath(path.join(fixtureRoot, "app/admin/actions.ts")),
    );
    const offlineActionId = `${createHash("sha256").update(normalizedActionPath).digest("hex").slice(0, 12)}#deleteEverything`;

    expect(actionIds.deleteEverything).toBe(offlineActionId);
    const response = await handler(actionRequest("/", offlineActionId, []));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{}");
  });

  it("retains action ownership through client component boundaries", async () => {
    const direct = await handler(new Request("http://example.com/client-owner"));
    expect(direct.status).toBe(401);

    const response = await handler(actionRequest("/", actionIds.clientOwnedAction, []));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{}");
  });

  it("retains inline action ownership in imported Server Components", async () => {
    const importedActionId = findActionId(builtSource, "$$hoist_0_importedInlineAction");
    const response = await handler(actionRequest("/", importedActionId, []));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("IMPORTED_INLINE_ACTION_EXECUTED");
  });

  it("blocks cross-action closure replay and the composed redirect chain before action decode", async () => {
    const encryptedBoundArgs = await encryptBoundArgsFixture('0:["victim-carol"]\n');
    const encryptedBytes = Buffer.from(encryptedBoundArgs, "base64");
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: encryptedBytes.subarray(0, 16) },
      encryptionKey,
      encryptedBytes.subarray(16),
    );
    expect(new TextDecoder().decode(decrypted)).toBe('0:["victim-carol"]\n');

    const targetActionIds = findActionIds(builtSource, "$$hoist_0_deleteAccount");

    const responses = await Promise.all(
      targetActionIds.map(async (targetActionId) => {
        const response = await handler(actionRequest("/", targetActionId, [encryptedBoundArgs]));
        return {
          body: await response.text(),
          redirect: response.headers.get("x-action-redirect"),
          status: response.status,
        };
      }),
    );
    expect(responses.some((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => response.status === 200 || response.status === 404)).toBe(
      true,
    );
    for (const response of responses) {
      expect(response.redirect).toBeNull();
      expect(response.body).not.toContain("ADMIN_SECRET_MARKER_42");
      expect(response.body).not.toContain("victim-carol");
    }
  });

  it("does not inline middleware-gated redirect targets into action responses", async () => {
    const direct = await handler(new Request("http://example.com/admin/secret"));
    expect(direct.status).toBe(401);

    const response = await handler(actionRequest("/", actionIds.goTo, ["/admin/secret"]));
    const body = await response.text();

    expect(response.status).toBe(303);
    expect(response.headers.get("x-action-redirect")).toBe("/admin/secret");
    expect(body).not.toContain("ADMIN_SECRET_MARKER_42");
    expect(body).toBe("");
  });

  it("associates every action exported by a reachable server-reference module", async () => {
    const adminOnlyId = findActionId(builtSource, "adminOnly");
    const response = await handler(actionRequest("/shared", adminOnlyId, []));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("ADMIN_SHARED_ACTION_EXECUTED");
  });

  it("fails closed for unknown action ids", async () => {
    const response = await handler(actionRequest("/", "000000000000#missing", []));
    expect(response.status).toBe(404);
  });

  it("forwards dynamic-route owners through middleware using a concrete pathname", async () => {
    const dynamicActionId = findActionId(builtSource, "$$hoist_0_dynamicAdmin");
    const response = await handler(actionRequest("/", dynamicActionId, []));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("{}");
  });

  it("merges middleware response cookies into the forwarded action request", async () => {
    const cookieActionId = findActionId(builtSource, "$$hoist_0_readForwardedCookie");
    const response = await handler(actionRequest("/cookie-source", cookieActionId, []));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("present");
    expect(body).toContain("trusted");
  });

  it("stops recursive forwarding after an owner-route middleware rewrite", async () => {
    const loopActionId = findActionId(builtSource, "$$hoist_0_loopAction");
    const response = await handler(actionRequest("/", loopActionId, []));
    expect([200, 404]).toContain(response.status);
    expect(await response.text()).not.toContain("LOOP_ACTION_EXECUTED");
  });
});
