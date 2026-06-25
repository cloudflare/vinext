export default function MetadataStreamingParallelDynamicLayout({
  children,
  headersSlot,
  cookiesSlot,
  connectionSlot,
}: {
  children: React.ReactNode;
  headersSlot: React.ReactNode;
  cookiesSlot: React.ReactNode;
  connectionSlot: React.ReactNode;
}) {
  return (
    <main>
      {children}
      {headersSlot}
      {cookiesSlot}
      {connectionSlot}
    </main>
  );
}
