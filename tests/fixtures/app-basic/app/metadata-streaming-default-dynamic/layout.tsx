export default function MetadataStreamingDefaultDynamicLayout({
  children,
  dynamicSlot,
}: {
  children: React.ReactNode;
  dynamicSlot: React.ReactNode;
}) {
  return (
    <main>
      {children}
      {dynamicSlot}
    </main>
  );
}
