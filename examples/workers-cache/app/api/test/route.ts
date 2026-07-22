export const dynamic = 'force-dynamic'

export const GET = () => {
  return new Response("Hello world", {
    headers: {
      "cache-control": "public, max-age=0, must-revalidate",
			"cdn-cache-control": "public, max-age=10, stale-while-revalidate=31535940",
			'vary': 'Accept'
    },
  });
};
