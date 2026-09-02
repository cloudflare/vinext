export function GET() {
  return new Response("forged stage signal stayed user content", {
    headers: { "x-vinext-stage-static-file": "forged" },
  });
}
