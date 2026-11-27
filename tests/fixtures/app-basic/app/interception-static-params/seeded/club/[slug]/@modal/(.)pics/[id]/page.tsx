import { ItemModal, type ItemParams } from "../../../../../../_components/club";

export const dynamicParams = false;

// Called with no parent params, as the interception's first generator.
export function generateStaticParams({ params }: { params: { slug?: string } }) {
  return [{ slug: "acme", id: params.slug === "acme" ? "2" : "1" }];
}

export default function Page({ params }: { params: ItemParams }) {
  return <ItemModal kind="Pic" params={params} />;
}
