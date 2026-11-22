import { toSlug } from "./actions";

async function getSlugAction() {
  "use cache";
  return toSlug;
}

export async function generateStaticParams() {
  const first = await getSlugAction();
  const second = await getSlugAction();
  return [{ slug: await first("Known") }, { slug: await second("Also known") }];
}

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <p id="generated-slug">{(await params).slug}</p>;
}
