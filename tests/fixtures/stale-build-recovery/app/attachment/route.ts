export function GET() {
  return new Response("name,value\nexample,1\n", {
    headers: {
      "content-disposition": 'attachment; filename="export.csv"',
      "content-type": "text/csv",
    },
  });
}
