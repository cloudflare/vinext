import { ItemModal, type ItemParams } from "../../../../../../_components/club";

export const dynamicParams = false;

export function generateStaticParams() {
  return [{}];
}

export default function Page({ params }: { params: ItemParams }) {
  return <ItemModal kind="Pic" params={params} />;
}
