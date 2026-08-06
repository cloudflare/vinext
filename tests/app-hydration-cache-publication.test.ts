import { describe, expect, it, vi } from "vite-plus/test";
import { createHydrationCachePublication } from "../packages/vinext/src/server/app-hydration-cache-publication.js";

describe("initial hydration cache publication", () => {
  it("publishes a candidate only after the BrowserRoot commit", () => {
    const publication = createHydrationCachePublication();
    const invalidate = vi.fn();
    const publish = vi.fn(() => invalidate);

    publication.publish(publish);
    expect(publish).not.toHaveBeenCalled();

    publication.commit();
    expect(publish).toHaveBeenCalledOnce();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("publishes a late candidate after the BrowserRoot commit", () => {
    const publication = createHydrationCachePublication();
    const publish = vi.fn(() => vi.fn());

    publication.commit();
    publication.publish(publish);

    expect(publish).toHaveBeenCalledOnce();
  });

  it("publishes a candidate that finishes buffering after hydration completes", () => {
    const publication = createHydrationCachePublication();
    const publish = vi.fn(() => vi.fn());

    publication.commit();
    publication.complete();
    publication.publish(publish);

    expect(publish).toHaveBeenCalledOnce();
  });

  it("cancels an unpublished candidate when hydration fails", () => {
    const publication = createHydrationCachePublication();
    const publish = vi.fn(() => vi.fn());

    publication.publish(publish);
    publication.fail();
    publication.commit();

    expect(publish).not.toHaveBeenCalled();
  });

  it("invalidates a committed candidate when hydration fails before passive completion", () => {
    const publication = createHydrationCachePublication();
    const invalidate = vi.fn();

    publication.commit();
    publication.publish(() => invalidate);
    publication.fail();

    expect(invalidate).toHaveBeenCalledOnce();
  });

  it("does not discard a completed hydration candidate for a later root error", () => {
    const publication = createHydrationCachePublication();
    const invalidate = vi.fn();

    publication.commit();
    publication.publish(() => invalidate);
    publication.complete();
    publication.fail();

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("invalidates the exact published candidate on cleanup", () => {
    const publication = createHydrationCachePublication();
    const invalidate = vi.fn();

    publication.commit();
    publication.publish(() => invalidate);
    publication.invalidate();
    publication.invalidate();

    expect(invalidate).toHaveBeenCalledOnce();
  });
});
