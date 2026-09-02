const origin = "http://127.0.0.1:8788";

for (const path of ["/single", "/stacked"]) {
  const response = await fetch(`${origin}${path}`, {
    headers: { "accept-encoding": "gzip" },
  });

  console.log(path, {
    contentEncoding: response.headers.get("content-encoding"),
    json: await response.json(),
  });
}
