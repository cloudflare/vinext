type FlightFramingState = typeof globalThis & {
  __flightFramingEntries?: string[];
};

export async function POST(request: Request) {
  (globalThis as FlightFramingState).__flightFramingEntries = await request.json();
  return new Response(null, { status: 204 });
}
