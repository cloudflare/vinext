import {
  cloneElement,
  createElement,
  isValidElement,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";
import { runWithInstantPrefetchShellStage } from "vinext/shims/instant-prefetch-shell";
import { invokeAppComponent, isReactOwnedAppComponent } from "./app-render-dependency.js";
import { isPromiseLike } from "../utils/promise.js";

export type AppInstantPrefetchSegmentStage = "runtime" | "static";

type AppInstantPrefetchModule = Readonly<Record<string, unknown>> | null | undefined;

type InstantConfig = Readonly<{
  prefetch?: unknown;
}>;

export type AppInstantPrefetchSegmentStages = Readonly<{
  layouts: readonly AppInstantPrefetchSegmentStage[];
  page: AppInstantPrefetchSegmentStage;
}>;

function isRuntimeInstantModule(module: AppInstantPrefetchModule): boolean {
  const config = module?.unstable_instant as InstantConfig | null | undefined;
  return typeof config === "object" && config !== null && config.prefetch === "runtime";
}

export function resolveAppInstantPrefetchSegmentStage(
  module: AppInstantPrefetchModule,
  inheritedStage: AppInstantPrefetchSegmentStage,
): AppInstantPrefetchSegmentStage {
  return isRuntimeInstantModule(module) ? "runtime" : inheritedStage;
}

/**
 * Resolve the stage for each segment in the combined Vinext response.
 *
 * Next starts a combined runtime request at the first new segment with a
 * runtime hint. All lower segments join that request, even when they default
 * to static. A retained runtime layout is still in the shared part of the
 * tree, so it must not make the newly requested child subtree runtime.
 *
 * @see https://github.com/vercel/next.js/blob/v16.2.6/packages/next/src/client/components/segment-cache/scheduler.ts
 */
export function resolveAppInstantPrefetchSegmentStages(options: {
  layouts: readonly AppInstantPrefetchModule[];
  page: AppInstantPrefetchModule;
  retainedLayouts?: ReadonlySet<number>;
}): AppInstantPrefetchSegmentStages {
  let activeStage: AppInstantPrefetchSegmentStage = "static";
  const layouts = options.layouts.map((module, index) => {
    if (!options.retainedLayouts?.has(index)) {
      activeStage = resolveAppInstantPrefetchSegmentStage(module, activeStage);
    }
    return activeStage;
  });

  activeStage = resolveAppInstantPrefetchSegmentStage(options.page, activeStage);

  return { layouts, page: activeStage };
}

type SegmentBoundaryProps = Readonly<{
  component: ComponentType<Record<string, unknown>>;
  componentProps: Readonly<Record<string, unknown>>;
  stage: AppInstantPrefetchSegmentStage;
}>;

function wrapSegmentSubtree(value: ReactNode, stage: AppInstantPrefetchSegmentStage): ReactNode {
  if (Array.isArray(value)) {
    return value.map((child) => wrapSegmentSubtree(child, stage));
  }
  if (!isValidElement(value)) return value;

  const element = value as ReactElement<Record<string, unknown>>;
  if (!isReactOwnedAppComponent(element.type)) {
    return createElement(InstantPrefetchSegmentBoundary, {
      key: element.key,
      component: element.type as ComponentType<Record<string, unknown>>,
      componentProps: element.props,
      stage,
    });
  }

  if (!("children" in element.props)) return element;
  return cloneElement(
    element,
    undefined,
    wrapSegmentSubtree(element.props.children as ReactNode, stage),
  );
}

function InstantPrefetchSegmentBoundary({
  component,
  componentProps,
  stage,
}: SegmentBoundaryProps): ReactNode | Promise<ReactNode> {
  return runWithInstantPrefetchShellStage(stage, () => {
    const result = invokeAppComponent(component, componentProps);
    return isPromiseLike(result)
      ? Promise.resolve(result).then((resolved) => wrapSegmentSubtree(resolved, stage))
      : wrapSegmentSubtree(result, stage);
  });
}

InstantPrefetchSegmentBoundary.displayName = "Vinext.InstantPrefetchSegmentBoundary";

export function wrapAppInstantPrefetchSegment(
  element: ReactNode,
  stage: AppInstantPrefetchSegmentStage,
): ReactNode {
  return wrapSegmentSubtree(element, stage);
}
