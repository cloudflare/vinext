/**
 * Dynamic route validation and sorting adapted from Next.js' sorted-routes implementation.
 * Source:
 * https://github.com/vercel/next.js/blob/canary/packages/next/src/shared/lib/router/utils/sorted-routes.ts
 */

import { removeTrailingSlash } from "../utils/base-path.js";

class UrlNode {
  placeholder = true;
  children = new Map<string, UrlNode>();
  slugName: string | null = null;
  restSlugName: string | null = null;
  optionalRestSlugName: string | null = null;

  insert(urlPath: string): void {
    this.insertSegments(urlPath.split("/").filter(Boolean), [], false);
  }

  private insertSegments(urlPaths: string[], slugNames: string[], isCatchAll: boolean): void {
    if (urlPaths.length === 0) {
      this.placeholder = false;
      return;
    }

    if (isCatchAll) {
      throw new Error("Catch-all must be the last part of the URL.");
    }

    let nextSegment = urlPaths[0];

    if (nextSegment.startsWith("[") && nextSegment.endsWith("]")) {
      let segmentName = nextSegment.slice(1, -1);

      let isOptional = false;
      if (segmentName.startsWith("[") && segmentName.endsWith("]")) {
        segmentName = segmentName.slice(1, -1);
        isOptional = true;
      }

      if (segmentName.startsWith("…")) {
        throw new Error(
          `Detected a three-dot character ('…') at ('${segmentName}'). Did you mean ('...')?`,
        );
      }

      if (segmentName.startsWith("...")) {
        segmentName = segmentName.substring(3);
        isCatchAll = true;
      }

      if (segmentName.startsWith("[") || segmentName.endsWith("]")) {
        throw new Error(
          `Segment names may not start or end with extra brackets ('${segmentName}').`,
        );
      }

      if (segmentName.startsWith(".")) {
        throw new Error(`Segment names may not start with erroneous periods ('${segmentName}').`);
      }

      const handleSlug = (previousSlug: string | null, nextSlug: string): void => {
        if (previousSlug !== null && previousSlug !== nextSlug) {
          throw new Error(
            `You cannot use different slug names for the same dynamic path ('${previousSlug}' !== '${nextSlug}').`,
          );
        }

        for (const slug of slugNames) {
          if (slug === nextSlug) {
            throw new Error(
              `You cannot have the same slug name "${nextSlug}" repeat within a single dynamic path`,
            );
          }

          if (slug.replace(/\W/g, "") === nextSegment.replace(/\W/g, "")) {
            throw new Error(
              `You cannot have the slug names "${slug}" and "${nextSlug}" differ only by non-word symbols within a single dynamic path`,
            );
          }
        }

        slugNames.push(nextSlug);
      };

      if (isCatchAll) {
        if (isOptional) {
          if (this.restSlugName !== null) {
            throw new Error(
              `You cannot use both an required and optional catch-all route at the same level ("[...${this.restSlugName}]" and "${urlPaths[0]}" ).`,
            );
          }

          handleSlug(this.optionalRestSlugName, segmentName);
          this.optionalRestSlugName = segmentName;
          nextSegment = "[[...]]";
        } else {
          if (this.optionalRestSlugName !== null) {
            throw new Error(
              `You cannot use both an optional and required catch-all route at the same level ("[[...${this.optionalRestSlugName}]]" and "${urlPaths[0]}").`,
            );
          }

          handleSlug(this.restSlugName, segmentName);
          this.restSlugName = segmentName;
          nextSegment = "[...]";
        }
      } else {
        if (isOptional) {
          throw new Error(`Optional route parameters are not yet supported ("${urlPaths[0]}").`);
        }

        handleSlug(this.slugName, segmentName);
        this.slugName = segmentName;
        nextSegment = "[]";
      }
    }

    let child = this.children.get(nextSegment);
    if (!child) {
      child = new UrlNode();
      this.children.set(nextSegment, child);
    }

    child.insertSegments(urlPaths.slice(1), slugNames, isCatchAll);
  }

  /**
   * Flatten the tree into route-priority order: static children
   * alphabetically, then the dynamic, catch-all and optional catch-all
   * children. Throws when a route shares a level with an optional catch-all.
   */
  smoosh(prefix = "/"): string[] {
    const childrenPaths = [...this.children.keys()]
      .filter((segment) => segment !== "[]" && segment !== "[...]" && segment !== "[[...]]")
      .sort();

    const routes = childrenPaths.flatMap((segment) =>
      this.children.get(segment)!.smoosh(`${prefix}${segment}/`),
    );

    if (this.slugName !== null) {
      routes.push(...this.children.get("[]")!.smoosh(`${prefix}[${this.slugName}]/`));
    }

    if (!this.placeholder) {
      const route = prefix === "/" ? "/" : prefix.slice(0, -1);
      if (this.optionalRestSlugName !== null) {
        throw new Error(
          `You cannot define a route with the same specificity as a optional catch-all route ("${route}" and "${route}[[...${this.optionalRestSlugName}]]").`,
        );
      }

      routes.unshift(route);
    }

    if (this.restSlugName !== null) {
      routes.push(...this.children.get("[...]")!.smoosh(`${prefix}[...${this.restSlugName}]/`));
    }

    if (this.optionalRestSlugName !== null) {
      routes.push(
        ...this.children.get("[[...]]")!.smoosh(`${prefix}[[...${this.optionalRestSlugName}]]/`),
      );
    }

    return routes;
  }
}

/**
 * Sort Next.js-format page paths (e.g. "/posts/[id]") into route-priority
 * order, matching Next.js' `getSortedRoutes`.
 */
export function getSortedRoutes(pages: readonly string[]): string[] {
  const root = new UrlNode();
  for (const page of pages) root.insert(page);
  return root.smoosh();
}

export function patternToNextFormat(pattern: string): string {
  if (pattern === "/") return "/";

  return pattern
    .split("/")
    .map((segment) => {
      if (!segment.startsWith(":")) return segment;
      const parameter = segment.slice(1);
      if (parameter.endsWith("+")) return `[...${parameter.slice(0, -1)}]`;
      if (parameter.endsWith("*")) return `[[...${parameter.slice(0, -1)}]]`;
      return `[${parameter}]`;
    })
    .join("/");
}

function normalizeRoutePattern(pattern: string): string {
  return removeTrailingSlash(pattern);
}

export function validateRoutePatterns(patterns: readonly string[]): void {
  const root = new UrlNode();
  const seenPatterns = new Set<string>();
  for (const pattern of patterns) {
    const normalizedPattern = normalizeRoutePattern(pattern);
    if (seenPatterns.has(normalizedPattern)) {
      throw new Error(
        `You cannot have two routes that resolve to the same path ("${normalizedPattern}").`,
      );
    }
    seenPatterns.add(normalizedPattern);
    root.insert(patternToNextFormat(normalizedPattern));
  }
  root.smoosh();
}
