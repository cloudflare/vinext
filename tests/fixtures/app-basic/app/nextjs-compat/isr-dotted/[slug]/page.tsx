import { sharedImportedNow } from "../../../../../shared/rsc-shared-now";

export default async function IsrDottedPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  return (
    <>
      <p id="dotted-slug">{slug}</p>
      <p id="dotted-imported-now">{sharedImportedNow}</p>
    </>
  );
}
