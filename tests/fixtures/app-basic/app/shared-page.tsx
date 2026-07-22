async function getData() {
  const target =
    process.env.TEST_REVALIDATE_PATH_REWRITES_TARGET ??
    "data:text/plain,revalidate-path-with-rewrites-default";

  const res = await fetch(target);
  return res.text();
}

export default async function SharedPage({ isDynamic }: { isDynamic: boolean }) {
  const data = await getData();

  return (
    <div>
      <h1>{isDynamic ? "Dynamic" : "Static"} Page</h1>
      <p>
        Random data: <span id="random-data">{data}</span>
      </p>
    </div>
  );
}
