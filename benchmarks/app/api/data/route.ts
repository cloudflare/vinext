export function GET() {
  const data = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, value: Math.random(), label: `Item ${i + 1}` }));
  return Response.json(data);
}

