import { ItemPage, type ItemParams } from "../../../../../_components/club";

export const dynamicParams = false;

export function generateStaticParams() {
  return [{ slug: "acme", id: "1" }];
}

export default function Page({ params }: { params: ItemParams }) {
  return <ItemPage kind="Pic" params={params} />;
}
