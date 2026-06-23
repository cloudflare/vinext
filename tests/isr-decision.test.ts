import { describe, expect, it } from "vite-plus/test";
import {
  decideIsr,
  buildMissIsrCacheControl,
  buildAppRouteMissIsrCacheControl,
  ISR_NEVER_CACHE_CONTROL,
  ISR_NO_STORE_CACHE_CONTROL,
} from "../packages/vinext/src/server/isr-decision.js";

// ─── MISS ────────────────────────────────────────────────────────────────────

describe("decideIsr — MISS", () => {
  it("returns MISS when cacheState is MISS", () => {
    const d = decideIsr({
      cacheState: "MISS",
      kind: "app-page",
      revalidateSeconds: 60,
    });
    expect(d.disposition).toBe("MISS");
    expect(d.scheduleRegeneration).toBe(false);
    expect(d.cacheControl).toBe("");
  });

  it("returns MISS for MISS cacheState regardless of route kind", () => {
    const d = decideIsr({
      cacheState: "MISS",
      kind: "pages",
      revalidateSeconds: 60,
    });
    expect(d.disposition).toBe("MISS");
    expect(d.scheduleRegeneration).toBe(false);
  });
});

// ─── HIT ─────────────────────────────────────────────────────────────────────

describe("decideIsr — HIT", () => {
  it("app-page HIT without expire: unbounded SWR", () => {
    const d = decideIsr({
      cacheState: "HIT",
      kind: "app-page",
      revalidateSeconds: 60,
    });
    expect(d.disposition).toBe("HIT");
    expect(d.scheduleRegeneration).toBe(false);
    expect(d.cacheControl).toBe("s-maxage=60, stale-while-revalidate");
  });

  it("app-page HIT with expireSeconds only (no cacheControlMeta): expire is unknown, unbounded SWR", () => {
    // expireSeconds is only a fallback for cacheControlMeta. Without metadata,
    // the expire ceiling is unknown and the unbounded form is used.
    const d = decideIsr({
      cacheState: "HIT",
      kind: "app-page",
      revalidateSeconds: 60,
      expireSeconds: 300,
    });
    expect(d.cacheControl).toBe("s-maxage=60, stale-while-revalidate");
  });

  it("app-page HIT with cacheControlMeta including expire: finite SWR window", () => {
    const d = decideIsr({
      cacheState: "HIT",
      kind: "app-page",
      revalidateSeconds: 60,
      expireSeconds: 300,
      cacheControlMeta: { revalidate: 60, expire: 300 },
    });
    expect(d.cacheControl).toBe("s-maxage=60, stale-while-revalidate=240");
  });

  it("app-page HIT: prefers cacheControlMeta revalidate over route default", () => {
    const d = decideIsr({
      cacheState: "HIT",
      kind: "app-page",
      revalidateSeconds: 60,
      cacheControlMeta: { revalidate: 30 },
    });
    expect(d.cacheControl).toBe("s-maxage=30, stale-while-revalidate");
  });

  it("app-page HIT: cacheControlMeta expire overrides route expireSeconds", () => {
    const d = decideIsr({
      cacheState: "HIT",
      kind: "app-page",
      revalidateSeconds: 60,
      expireSeconds: 999,
      cacheControlMeta: { revalidate: 60, expire: 300 },
    });
    expect(d.cacheControl).toBe("s-maxage=60, stale-while-revalidate=240");
  });

  it("app-page HIT: cacheControlMeta present but no expire — expireSeconds used as fallback", () => {
    const d = decideIsr({
      cacheState: "HIT",
      kind: "app-page",
      revalidateSeconds: 60,
      expireSeconds: 300,
      cacheControlMeta: { revalidate: 60 },
    });
    expect(d.cacheControl).toBe("s-maxage=60, stale-while-revalidate=240");
  });

  it("pages HIT without cacheControlMeta: unbounded SWR", () => {
    const d = decideIsr({
      cacheState: "HIT",
      kind: "pages",
      revalidateSeconds: 60,
    });
    expect(d.cacheControl).toBe("s-maxage=60, stale-while-revalidate");
  });

  it("pages HIT with cacheControlMeta and expire: finite SWR window", () => {
    const d = decideIsr({
      cacheState: "HIT",
      kind: "pages",
      revalidateSeconds: 60,
      cacheControlMeta: { revalidate: 60, expire: 300 },
    });
    expect(d.cacheControl).toBe("s-maxage=60, stale-while-revalidate=240");
  });

  it("app-route HIT finite revalidate (no metadata): uses route policy, unbounded SWR", () => {
    const d = decideIsr({
      cacheState: "HIT",
      kind: "app-route",
      revalidateSeconds: 60,
    });
    expect(d.cacheControl).toBe("s-maxage=60, stale-while-revalidate");
  });

  it("app-route HIT revalidate=0: emits NEVER_CACHE_CONTROL", () => {
    const d = decideIsr({
      cacheState: "HIT",
      kind: "app-route",
      revalidateSeconds: 0,
    });
    expect(d.cacheControl).toBe(ISR_NEVER_CACHE_CONTROL);
  });

  it("app-route HIT revalidate=Infinity: emits STATIC_CACHE_CONTROL", () => {
    const d = decideIsr({
      cacheState: "HIT",
      kind: "app-route",
      revalidateSeconds: Infinity,
    });
    expect(d.cacheControl).toBe("s-maxage=31536000, stale-while-revalidate");
  });

  it("app-route HIT: cacheControlMeta revalidate=0 wins over route default", () => {
    const d = decideIsr({
      cacheState: "HIT",
      kind: "app-route",
      revalidateSeconds: 60,
      cacheControlMeta: { revalidate: 0 },
    });
    expect(d.cacheControl).toBe(ISR_NEVER_CACHE_CONTROL);
  });

  it("dev HIT: unbounded SWR (no special gates)", () => {
    const d = decideIsr({
      cacheState: "HIT",
      kind: "dev",
      revalidateSeconds: 60,
    });
    expect(d.disposition).toBe("HIT");
    expect(d.cacheControl).toBe("s-maxage=60, stale-while-revalidate");
  });
});

// ─── STALE ───────────────────────────────────────────────────────────────────

describe("decideIsr — STALE", () => {
  it("app-page STALE without expire: s-maxage=0 (canonical STALE fallback)", () => {
    const d = decideIsr({
      cacheState: "STALE",
      kind: "app-page",
      revalidateSeconds: 60,
    });
    expect(d.disposition).toBe("STALE");
    expect(d.scheduleRegeneration).toBe(true);
    expect(d.cacheControl).toBe("s-maxage=0, stale-while-revalidate");
  });

  it("app-page STALE with cacheControlMeta and expire: uses route policy (same as HIT)", () => {
    const d = decideIsr({
      cacheState: "STALE",
      kind: "app-page",
      revalidateSeconds: 60,
      cacheControlMeta: { revalidate: 60, expire: 300 },
    });
    expect(d.cacheControl).toBe("s-maxage=60, stale-while-revalidate=240");
  });

  it("app-page STALE: scheduleRegeneration is true", () => {
    const d = decideIsr({
      cacheState: "STALE",
      kind: "app-page",
      revalidateSeconds: 60,
    });
    expect(d.scheduleRegeneration).toBe(true);
  });

  it("pages STALE without expire: s-maxage=0", () => {
    const d = decideIsr({
      cacheState: "STALE",
      kind: "pages",
      revalidateSeconds: 60,
    });
    expect(d.cacheControl).toBe("s-maxage=0, stale-while-revalidate");
  });

  it("pages STALE with cacheControlMeta and expire: finite SWR window", () => {
    const d = decideIsr({
      cacheState: "STALE",
      kind: "pages",
      revalidateSeconds: 15,
      cacheControlMeta: { revalidate: 15, expire: 300 },
    });
    expect(d.cacheControl).toBe("s-maxage=15, stale-while-revalidate=285");
  });

  it("app-route STALE revalidate=0: NEVER_CACHE_CONTROL", () => {
    const d = decideIsr({
      cacheState: "STALE",
      kind: "app-route",
      revalidateSeconds: 0,
    });
    expect(d.cacheControl).toBe(ISR_NEVER_CACHE_CONTROL);
  });

  it("app-route STALE revalidate=Infinity: STATIC_CACHE_CONTROL", () => {
    const d = decideIsr({
      cacheState: "STALE",
      kind: "app-route",
      revalidateSeconds: Infinity,
    });
    expect(d.cacheControl).toBe("s-maxage=31536000, stale-while-revalidate");
  });

  it("app-route STALE finite (no cacheControlMeta): s-maxage=0 (STALE fallback, expire unknown)", () => {
    const d = decideIsr({
      cacheState: "STALE",
      kind: "app-route",
      revalidateSeconds: 60,
    });
    expect(d.cacheControl).toBe("s-maxage=0, stale-while-revalidate");
  });

  it("dev STALE: s-maxage=0 (deliberate parity fix, now matches prod Pages Router)", () => {
    // Previously emitted `s-maxage=<secs>, stale-while-revalidate`. Aligned to
    // the canonical buildCachedRevalidateCacheControl("STALE", secs) result which
    // is `s-maxage=0, stale-while-revalidate` when expire is absent, matching prod.
    const d = decideIsr({
      cacheState: "STALE",
      kind: "dev",
      revalidateSeconds: 60,
    });
    expect(d.disposition).toBe("STALE");
    expect(d.scheduleRegeneration).toBe(true);
    expect(d.cacheControl).toBe("s-maxage=0, stale-while-revalidate");
  });
});

// ─── buildMissIsrCacheControl ─────────────────────────────────────────────────

describe("buildMissIsrCacheControl", () => {
  it("without expire: unbounded SWR", () => {
    expect(buildMissIsrCacheControl(60)).toBe("s-maxage=60, stale-while-revalidate");
  });

  it("with expire: finite SWR window", () => {
    expect(buildMissIsrCacheControl(60, 300)).toBe("s-maxage=60, stale-while-revalidate=240");
  });

  it("expire <= revalidate: no SWR suffix", () => {
    expect(buildMissIsrCacheControl(300, 300)).toBe("s-maxage=300");
  });
});

// ─── buildAppRouteMissIsrCacheControl ─────────────────────────────────────────

describe("buildAppRouteMissIsrCacheControl", () => {
  it("revalidate=0: NEVER_CACHE_CONTROL", () => {
    expect(buildAppRouteMissIsrCacheControl(0)).toBe(ISR_NEVER_CACHE_CONTROL);
  });

  it("revalidate=Infinity: STATIC_CACHE_CONTROL", () => {
    expect(buildAppRouteMissIsrCacheControl(Infinity)).toBe(
      "s-maxage=31536000, stale-while-revalidate",
    );
  });

  it("finite revalidate with expire: finite SWR window", () => {
    expect(buildAppRouteMissIsrCacheControl(60, 600)).toBe(
      "s-maxage=60, stale-while-revalidate=540",
    );
  });

  it("finite revalidate without expire: unbounded SWR", () => {
    expect(buildAppRouteMissIsrCacheControl(60)).toBe("s-maxage=60, stale-while-revalidate");
  });
});

// ─── re-exported constants ────────────────────────────────────────────────────

describe("ISR_NEVER_CACHE_CONTROL / ISR_NO_STORE_CACHE_CONTROL", () => {
  it("ISR_NEVER_CACHE_CONTROL matches the canonical value", () => {
    expect(ISR_NEVER_CACHE_CONTROL).toBe("private, no-cache, no-store, max-age=0, must-revalidate");
  });

  it("ISR_NO_STORE_CACHE_CONTROL matches the canonical value", () => {
    expect(ISR_NO_STORE_CACHE_CONTROL).toBe("no-store, must-revalidate");
  });
});
