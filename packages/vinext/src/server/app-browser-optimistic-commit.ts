import type { AppElements } from "./app-elements.js";
import type { NavigationPayloadOutcome } from "./app-browser-navigation-controller.js";

export async function retainElementsAfterOptimisticCommit(options: {
  commit(): Promise<NavigationPayloadOutcome>;
  elements: AppElements;
}): Promise<AppElements | null> {
  return (await options.commit()) === "committed" ? options.elements : null;
}
