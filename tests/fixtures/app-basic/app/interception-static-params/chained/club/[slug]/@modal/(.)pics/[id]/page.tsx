import { ItemModal, type ItemParams } from "../../../../../../_components/club";

export const dynamicParams = false;

// Called with each `slug` the `@side` default generates.
export function generateStaticParams({ params }: { params: { slug?: string } }) {
  return [{ id: params.slug === "acme" ? "1" : "2" }];
}

export default function Page({ params }: { params: ItemParams }) {
  return <ItemModal kind="Pic" params={params} />;
}
