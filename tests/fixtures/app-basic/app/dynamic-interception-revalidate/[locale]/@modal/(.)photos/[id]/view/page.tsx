import { RevalidateModal } from "../../../../modal";

export default async function InterceptedPhotoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <div>
      <h1 id="dynamic-interception-revalidate-intercepted">Intercepted Page</h1>
      <RevalidateModal photoId={id} />
    </div>
  );
}
