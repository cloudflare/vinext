async function getCachedDate() {
  "use cache";

  // Ensure the value changes across revalidation events.
  return new Date().toISOString();
}

export async function GET() {
  const date1 = await getCachedDate();
  const date2 = await getCachedDate();

  return new Response(JSON.stringify({ date1, date2 }), {
    headers: { "content-type": "application/json" },
  });
}
