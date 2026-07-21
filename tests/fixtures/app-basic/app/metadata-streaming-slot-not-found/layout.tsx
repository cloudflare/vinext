export default function MetadataStreamingSlotLayout({
  children,
  foo,
}: {
  children: React.ReactNode;
  foo: React.ReactNode;
}) {
  return (
    <main>
      {children}
      {foo}
    </main>
  );
}
