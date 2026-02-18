import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Suspense Metadata Title",
  description: "Testing metadata in suspense layout",
  applicationName: "suspense-app",
};

export default function SuspenseMetadataPage() {
  return (
    <div>
      <h1 id="suspense-page">Suspense Metadata Page</h1>
      <p>This page has metadata and its layout is wrapped in Suspense.</p>
    </div>
  );
}
