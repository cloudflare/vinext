import Link from "next/link";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default async function LoadingScrollPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; skipSleep?: string }>;
}) {
  const search = await searchParams;

  if (search.skipSleep !== "1") {
    await sleep(1000);
  }

  return (
    <>
      {search.page ? <div id="current-page">{search.page}</div> : null}
      <div style={{ display: "none" }}>Content that is hidden.</div>
      <div id="content-that-is-visible">Content which is not hidden.</div>
      <div style={{ height: 1, width: 10000 }} />
      {Array.from({ length: 500 }, (_, index) => (
        <div key={index}>{index}</div>
      ))}
      <div id="pages">
        {Array.from({ length: 10 }, (_, index) => {
          const page = index + 1;
          return (
            <Link key={page} href={`?page=${page}&skipSleep=1`}>
              {page}
            </Link>
          );
        })}
      </div>
    </>
  );
}
