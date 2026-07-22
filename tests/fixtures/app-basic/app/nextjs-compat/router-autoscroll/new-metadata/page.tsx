import type { Metadata } from "next";

export const metadata: Metadata = {
  keywords: ["new-metadata"],
};

export default function NewMetadataPage() {
  return (
    <>
      <div id="new-metadata-page">New metadata page</div>
      {Array.from({ length: 500 }, (_, index) => (
        <div key={index}>{index}</div>
      ))}
    </>
  );
}
