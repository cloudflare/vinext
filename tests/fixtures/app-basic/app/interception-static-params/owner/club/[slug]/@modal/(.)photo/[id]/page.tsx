import { ItemModal, type ItemParams } from "../../../../../../_components/club";

export function generateStaticParams() {
  return [{ id: "1" }];
}

export default function Page({ params }: { params: ItemParams }) {
  return <ItemModal kind="Photo" params={params} />;
}
