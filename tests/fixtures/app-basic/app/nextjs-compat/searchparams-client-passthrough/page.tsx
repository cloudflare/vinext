import ClientComponent from "./client-component";

export default function Page({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  return <ClientComponent searchParams={searchParams} />;
}
