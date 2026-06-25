export const revalidate = 1;

export async function generateMetadata() {
  await new Promise((resolve) => setTimeout(resolve, 25));
  const generation = Date.now();
  return {
    title: `ISR metadata ${generation}`,
    description: `ISR metadata generation ${generation}`,
  };
}

export default function MetadataStreamingIsrPage() {
  return <main>ISR metadata page</main>;
}
