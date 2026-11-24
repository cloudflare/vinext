import { describe, expect, it, vi } from "vite-plus/test";
import { createAppBrowserDocumentLoadTracker } from "../packages/vinext/src/server/app-browser-document-load.js";

describe("app browser document load tracker", () => {
  it("runs the start callbacks once the load starts", () => {
    const loads = createAppBrowserDocumentLoadTracker();
    const load = loads.enter();
    const onStart = vi.fn();
    const onSupersede = vi.fn();
    loads.onSettled(load, onStart, onSupersede);
    expect(onStart).not.toHaveBeenCalled();

    loads.start(load);
    loads.start(load);
    loads.supersede();
    expect(onStart).toHaveBeenCalledOnce();
    expect(onSupersede).not.toHaveBeenCalled();
    expect(load.status).toBe("started");
  });

  it("runs the supersede callbacks once the update that replaced the MPA state commits", () => {
    const loads = createAppBrowserDocumentLoadTracker();
    const load = loads.enter();
    const onStart = vi.fn();
    const onSupersede = vi.fn();
    loads.onSettled(load, onStart, onSupersede);

    loads.supersede();
    loads.start(load);
    expect(load.status).toBe("superseded");
    expect(onSupersede).not.toHaveBeenCalled();
    const late = vi.fn();
    loads.onSettled(load, vi.fn(), late);

    loads.commit();
    loads.commit();
    expect(onSupersede).toHaveBeenCalledOnce();
    expect(late).toHaveBeenCalledOnce();
    expect(onStart).not.toHaveBeenCalled();
  });

  it("joins an MPA state entered before the pending one renders", () => {
    const loads = createAppBrowserDocumentLoadTracker();
    const first = loads.enter();
    const onStart = vi.fn();
    loads.onSettled(first, onStart);

    const second = loads.enter();
    expect(second).toBe(first);
    loads.start(second);
    expect(onStart).toHaveBeenCalledOnce();

    // Once that load settles, the next MPA state is a new load.
    expect(loads.enter()).not.toBe(first);
  });

  it("runs a callback at once for a load that already settled", () => {
    const loads = createAppBrowserDocumentLoadTracker();
    const started = loads.enter();
    loads.start(started);
    const superseded = loads.enter();
    loads.supersede();
    loads.commit();

    const onStart = vi.fn();
    const onSupersede = vi.fn();
    loads.onSettled(started, onStart, onSupersede);
    expect(onStart).toHaveBeenCalledOnce();
    loads.onSettled(superseded, onStart, onSupersede);
    expect(onSupersede).toHaveBeenCalledOnce();
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("counts every entry, including one that joins the pending load", () => {
    const loads = createAppBrowserDocumentLoadTracker();
    expect(loads.entries()).toBe(0);
    const load = loads.enter();
    expect(loads.enter()).toBe(load);
    expect(loads.entries()).toBe(2);
  });

  it("reports the latest load entered", () => {
    const loads = createAppBrowserDocumentLoadTracker();
    expect(loads.latest()).toBeNull();
    const load = loads.enter();
    expect(loads.latest()).toBe(load);
    loads.start(load);
    expect(loads.latest()).toBe(load);
  });
});
