import { ItemPage, type ItemParams } from "../../../../../../_components/club";

export default function Page({ params }: { params: ItemParams }) {
  return <ItemPage kind="Details" params={params} />;
}
