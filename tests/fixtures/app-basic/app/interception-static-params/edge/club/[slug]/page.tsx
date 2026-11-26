import { ClubLinks, type ClubParams } from "../../../_components/club";

export default async function Page({ params }: { params: ClubParams }) {
  const { slug } = await params;
  return <ClubLinks base="edge" slug={slug} />;
}
