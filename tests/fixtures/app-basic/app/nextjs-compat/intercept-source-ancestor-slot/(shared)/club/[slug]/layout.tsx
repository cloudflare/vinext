export default async function ClubLayout({
  children,
  modal,
  params,
}: {
  children: React.ReactNode;
  modal: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <div id="intercept-ancestor-slot-club-layout">
      <p>Club layout: {slug}</p>
      {children}
      {modal}
    </div>
  );
}
