// No generateStaticParams - this is NOT an ISR page
export default async function NonISRPage({ params }: { params: Promise<{ item: string }> }) {
  const { item } = await params;

  return (
    <div>
      <h1>Non-ISR Dynamic Page: {item}</h1>
      <div id="non-isr-item-id">{item}</div>
    </div>
  );
}
