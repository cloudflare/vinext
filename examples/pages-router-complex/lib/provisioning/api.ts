import type { ServerGraphHandle } from "../graph-handle/server";
import type { ProvisioningOption } from "../view/lifted-props";
import type { Zone } from "../zones/zone";

export const provisioningCategory = (): string => "default";

export const fetchProvisioningOptions = async (
  handle: ServerGraphHandle,
  {
    category,
    zone,
    draft,
  }: {
    category: string;
    zone: Zone;
    draft?: boolean;
  },
): Promise<ProvisioningOption[] | null> => {
  try {
    return await handle.run<ProvisioningOption[]>("provisioningFor", {
      category,
      zoneId: zone.id,
      draft: !!draft,
    });
  } catch {
    return null;
  }
};
