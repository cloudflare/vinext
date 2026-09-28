import { cookies } from "next/headers";
import { RenderId } from "../../fixture-parts";
import { SearchValue } from "../../search-value";

export default async function Page() {
  await cookies();
  return (
    <main>
      <RenderId />
      <SearchValue />
    </main>
  );
}
