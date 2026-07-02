const DECODED_RSC_VIRTUAL_PREFIX = "/@id/\0virtual:vite-rsc/";
const ENCODED_RSC_VIRTUAL_PREFIX = "/@id/__x00__virtual:vite-rsc/";

type ClientReferenceMetaLike = {
  referenceKey: string;
};

function toEncodedViteRscVirtualReferenceKey(referenceId: string): string | null {
  return referenceId.startsWith(DECODED_RSC_VIRTUAL_PREFIX)
    ? ENCODED_RSC_VIRTUAL_PREFIX + referenceId.slice(DECODED_RSC_VIRTUAL_PREFIX.length)
    : null;
}

export function shouldAcceptDecodedViteRscReferenceValidation(
  referenceId: string,
  clientReferenceMetas: Iterable<ClientReferenceMetaLike>,
): boolean {
  const encodedReferenceKey = toEncodedViteRscVirtualReferenceKey(referenceId);
  if (encodedReferenceKey === null) return false;

  return Array.from(clientReferenceMetas).some((meta) => meta.referenceKey === encodedReferenceKey);
}
