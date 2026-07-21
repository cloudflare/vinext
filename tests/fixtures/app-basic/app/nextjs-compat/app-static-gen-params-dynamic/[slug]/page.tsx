export async function generateStaticParams() {
  return [{ slug: "one" }];
}

export default async function Page(props: { params: Promise<{ slug: string }> }) {
  const { slug } = await props.params;
  const target = process.env.TEST_APP_STATIC_DYNAMIC_TARGET;
  if (!target) {
    throw new Error("Missing TEST_APP_STATIC_DYNAMIC_TARGET");
  }

  const data = await fetch(target, {
    method: "POST",
    body: JSON.stringify({ hello: "world" }),
    next: { revalidate: 0 },
  }).then((res) => res.text());

  return (
    <>
      <p id="page">/nextjs-compat/app-static-gen-params-dynamic/[slug]</p>
      <p id="slug">{slug}</p>
      <p id="data">{data}</p>
    </>
  );
}
