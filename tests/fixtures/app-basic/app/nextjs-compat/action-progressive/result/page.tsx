type ResultPageProps = {
  searchParams: Promise<{
    name?: string;
    "hidden-info"?: string;
  }>;
};

export default async function ActionProgressiveResultPage({ searchParams }: ResultPageProps) {
  const params = await searchParams;

  return (
    <main>
      <h1>Action Progressive Result</h1>
      <p id="name">{params.name}</p>
      <p id="hidden-info">{params["hidden-info"]}</p>
    </main>
  );
}
