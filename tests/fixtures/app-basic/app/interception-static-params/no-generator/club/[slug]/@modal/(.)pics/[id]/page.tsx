import { ItemModal, type ItemParams } from "../../../../../../_components/club";

// Without a generator at its last dynamic segment, Next.js builds no paths for
// the interception, so it renders any params.
export const dynamicParams = false;

export default function Page({ params }: { params: ItemParams }) {
  return <ItemModal kind="Pic" params={params} />;
}
