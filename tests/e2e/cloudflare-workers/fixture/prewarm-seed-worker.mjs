export default {
  fetch(request) {
    if (request.headers.get("RSC") === "1") {
      return new Response("old-build flight", {
        headers: {
          "Cache-Control": "public, max-age=0, must-revalidate",
          "CF-Cache-Status": "MISS",
          "Content-Type": "text/x-component",
          Vary: "RSC, Next-Router-State-Tree, Next-Router-Prefetch, Next-Router-Segment-Prefetch, Next-Url, X-Vinext-Interception-Context, X-Vinext-Interception-Id, X-Vinext-Mounted-Slots, X-Vinext-Rsc-Render-Mode, X-Vinext-Rsc-State-Fingerprint",
          "X-Vinext-RSC-Build-Id": "old-build",
        },
      });
    }
    return new Response("old-build html", {
      headers: { "Content-Type": "text/html" },
    });
  },
};
