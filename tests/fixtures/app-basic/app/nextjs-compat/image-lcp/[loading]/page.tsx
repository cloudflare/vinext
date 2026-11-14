import Images from "../images";

export default async function Page({ params }: { params: Promise<{ loading: string }> }) {
  const { loading } = await params;
  return <Images mode={loading} />;
}
