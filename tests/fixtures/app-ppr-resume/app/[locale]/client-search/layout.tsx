import { cacheTag } from "next/cache";

async function getRouteStamp() {
  "use cache";
  cacheTag("regenerated");
  return new Date().toISOString();
}

// A cached stamp /api/revalidate invalidates, so the stored page regenerates.
export default async function ClientSearchLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <p id="route-stamp">{await getRouteStamp()}</p>
      {children}
    </>
  );
}
