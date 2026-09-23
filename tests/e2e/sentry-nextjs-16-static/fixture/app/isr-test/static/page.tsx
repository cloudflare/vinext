export const revalidate = 60; // ISR: revalidate every 60 seconds
export const dynamicParams = true;

export async function generateStaticParams(): Promise<never[]> {
  return [];
}

export default function ISRStaticPage() {
  return (
    <div>
      <h1>ISR Static Page</h1>
      <div id="isr-static-marker">static-isr</div>
    </div>
  );
}
