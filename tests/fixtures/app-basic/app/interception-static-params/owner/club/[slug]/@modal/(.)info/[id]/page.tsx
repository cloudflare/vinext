import { ItemModal, type ItemParams } from "../../../../../../_components/club";

export default function Page({ params }: { params: ItemParams }) {
  return <ItemModal kind="Info" params={params} />;
}
