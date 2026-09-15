import { patternToNextFormat } from "../routing/route-validation.js";
import { frameworkTracer } from "./tracer.js";

type PagesDataMethod = "getServerSideProps" | "getStaticProps";

export function createPagesDataSpanDescriptor(method: PagesDataMethod, routePattern: string) {
  const route = patternToNextFormat(routePattern);
  return {
    attributes: { "next.route": route },
    name: `${method} ${route}`,
    type: `Render.${method}`,
  } as const;
}

export function tracePagesData<T>(
  method: PagesDataMethod,
  routePattern: string,
  callback: () => T,
): T {
  return frameworkTracer.trace(createPagesDataSpanDescriptor(method, routePattern), callback);
}

export function createPagesApiHandlerSpanDescriptor(routePattern: string) {
  const route = patternToNextFormat(routePattern);
  return {
    name: `executing api route (pages) ${route}`,
    type: "Node.runHandler",
  } as const;
}

export function tracePagesApiHandler<T>(routePattern: string, callback: () => T): T {
  return frameworkTracer.trace(createPagesApiHandlerSpanDescriptor(routePattern), callback);
}
