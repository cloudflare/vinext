import { getDataCacheHandler } from "vinext/shims/cache-handler";
import { getCdnCacheAdapter } from "vinext/shims/cdn-cache";
import { setConditionalIo } from "../state";

const pageTag = "_N_T_/conditional-io/page";

async function setState(enabled: boolean): Promise<Response> {
  setConditionalIo(enabled);
  await Promise.all([
    getDataCacheHandler().revalidateTag(pageTag),
    getCdnCacheAdapter().revalidateTag(pageTag),
  ]);
  return new Response(null, { status: 204 });
}

export function DELETE() {
  return setState(false);
}

export function POST() {
  return setState(true);
}
