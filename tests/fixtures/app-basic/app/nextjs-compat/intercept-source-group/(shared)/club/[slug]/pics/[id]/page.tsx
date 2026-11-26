export const metadata = { title: "Pic page" };

export default async function PicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <p id="intercept-source-group-pic">Pic page: {id}</p>;
}
