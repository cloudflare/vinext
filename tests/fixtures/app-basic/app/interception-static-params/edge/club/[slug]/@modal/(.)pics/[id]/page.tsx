import { ItemModal, type ItemParams } from "../../../../../../_components/club";

// Next.js builds no paths for an edge-runtime route, so it renders any params.
export const runtime = "edge";
export const dynamicParams = false;

export default function Page({ params }: { params: ItemParams }) {
  return <ItemModal kind="Pic" params={params} />;
}
