import { describe, expect, it, vi } from "vite-plus/test";
import {
  createHttpAccessFallbackMetadataPlan,
  resolveHttpAccessFallbackMetadata,
  resolveHttpAccessFallbackViewport,
} from "../packages/vinext/src/server/app-page-http-access-fallback-metadata.js";

describe("HTTP-access fallback metadata planning", () => {
  it("places the fallback convention at every active leaf in owner order", () => {
    const rootLayout = {};
    const nestedLayout = {};
    const boundary = {};
    const rootSlotLayout = {};
    const nestedSlotLayout = {};
    const slotBoundary = {};

    const plan = createHttpAccessFallbackMetadataPlan({
      boundaryModule: boundary,
      boundaryParams: { locale: "en" },
      layoutModules: [rootLayout, nestedLayout],
      layoutTreePositions: [0, 1],
      parallelBranches: [
        {
          head: {
            layoutModules: [rootSlotLayout],
            layoutParams: [{}],
            routeSegments: ["[locale]", "posts", "[slug]"],
          },
          ownerTreePosition: 0,
        },
        {
          head: {
            layoutModules: [nestedSlotLayout],
            layoutParams: [{ locale: "en" }],
            routeSegments: ["[locale]", "posts", "[slug]"],
          },
          notFoundModule: slotBoundary,
          notFoundParams: { locale: "en", slug: "hello" },
          ownerTreePosition: 1,
        },
      ],
      params: { locale: "en", slug: "hello" },
      routeSegments: ["[locale]", "posts", "[slug]"],
    });

    expect(plan.map((source) => source.module)).toEqual([
      rootLayout,
      nestedLayout,
      slotBoundary,
      nestedSlotLayout,
      slotBoundary,
      rootSlotLayout,
      slotBoundary,
    ]);
    expect(
      plan.filter((source) => source.module === slotBoundary).map((source) => source.params),
    ).toEqual([
      { locale: "en", slug: "hello" },
      { locale: "en", slug: "hello" },
      { locale: "en", slug: "hello" },
    ]);
    expect(
      plan.filter((source) => source.module === slotBoundary).map((source) => source.routeSegments),
    ).toEqual([
      ["[locale]", "posts", "[slug]"],
      ["[locale]", "posts", "[slug]"],
      ["[locale]", "posts", "[slug]"],
    ]);
    expect(plan.every((source) => source.includeWhenEmpty)).toBe(true);
  });

  it("snapshots the active viewport convention at each fallback leaf", async () => {
    const boundary = { viewport: { width: "primary-only" } };
    const seenParams: unknown[] = [];
    const seenParents: unknown[] = [];
    const slotBoundary = {
      async generateViewport({ params }: { params: Promise<unknown> }, parent: Promise<unknown>) {
        seenParams.push(params);
        seenParents.push(await parent);
        return { themeColor: "slot" };
      },
    };

    const viewport = await resolveHttpAccessFallbackViewport<Record<string, unknown>>({
      boundaryModule: boundary,
      boundaryParams: { locale: "en" },
      layoutModules: [],
      parallelBranches: [
        {
          head: { routeSegments: ["[locale]", "posts", "[slug]"] },
          notFoundModule: slotBoundary,
          notFoundParams: { locale: "en", slug: "hello" },
          ownerTreePosition: 1,
        },
      ],
      params: { locale: "en", slug: "hello" },
      routeSegments: ["[locale]", "posts"],
    });

    expect(viewport.themeColor).toEqual([{ color: "slot" }]);
    expect(viewport.width).toBe("primary-only");
    expect(await Promise.all(seenParams)).toEqual([{ locale: "en", slug: "hello" }]);
    expect(seenParents).toEqual([
      {
        colorScheme: null,
        initialScale: 1,
        themeColor: null,
        width: "primary-only",
      },
    ]);
  });

  it("uses a sibling intercept as the primary leaf without inventing another leaf", () => {
    const rootLayout = {};
    const boundary = {};
    const interceptLayout = {};
    const slotLayout = {};

    const plan = createHttpAccessFallbackMetadataPlan({
      boundaryModule: boundary,
      boundaryParams: {},
      layoutModules: [rootLayout],
      layoutTreePositions: [0],
      parallelBranches: [
        {
          head: {
            layoutModules: [slotLayout],
            routeSegments: ["feed"],
          },
          ownerTreePosition: 0,
        },
      ],
      params: {},
      primaryParallelBranch: {
        head: {
          layoutModules: [interceptLayout],
          routeSegments: ["feed", "(..)photo", "[id]"],
        },
        ownerTreePosition: 1,
      },
      routeSegments: ["feed"],
    });

    expect(plan.map((source) => source.module)).toEqual([
      rootLayout,
      interceptLayout,
      boundary,
      slotLayout,
      boundary,
    ]);
  });

  it("starts generators eagerly while exposing accumulated metadata as parent", async () => {
    const started: string[] = [];
    const boundaryParents: unknown[] = [];
    let releaseRoot!: () => void;
    const rootGate = new Promise<void>((resolve) => {
      releaseRoot = resolve;
    });
    const rootLayout = {
      async generateMetadata() {
        started.push("root");
        await rootGate;
        return { description: "Root description" };
      },
    };
    const boundary = {
      async generateMetadata(_props: unknown, parent: Promise<{ description?: unknown }>) {
        started.push("boundary");
        boundaryParents.push((await parent).description);
        return { title: "Not found" };
      },
    };

    const metadataPromise = resolveHttpAccessFallbackMetadata<Record<string, unknown>>({
      boundaryModule: boundary,
      boundaryParams: {},
      layoutModules: [rootLayout],
      metadataRoutes: [],
      params: {},
      routePath: "/missing",
      routeSegments: ["missing"],
    });

    await vi.waitFor(() => expect(started).toEqual(["root", "boundary"]));
    releaseRoot();

    await expect(metadataPromise).resolves.toMatchObject({
      description: "Root description",
      title: "Not found",
    });
    expect(boundaryParents).toEqual(["Root description"]);
  });
});
