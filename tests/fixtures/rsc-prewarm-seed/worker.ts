export default {
  fetch(): Response {
    return new Response("old seed Worker", {
      status: 404,
      headers: { "x-vinext-seed-worker": "1" },
    });
  },
};
