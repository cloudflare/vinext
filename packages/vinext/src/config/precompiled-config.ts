import type { NextHeader, NextRedirect, NextRewrite } from "./next-config.js";
import {
  compileConfigPattern,
  compileHeaderSourcePattern,
  type CompiledConfigPattern,
} from "./config-matchers.js";

export type PrecompiledRewritePatterns = {
  beforeFiles: Array<CompiledConfigPattern | null>;
  afterFiles: Array<CompiledConfigPattern | null>;
  fallback: Array<CompiledConfigPattern | null>;
};

export type PrecompiledConfigPatterns = {
  redirects: Array<CompiledConfigPattern | null>;
  rewrites: PrecompiledRewritePatterns;
  headers: Array<RegExp | null>;
};

export function buildPrecompiledConfigPatterns(config: {
  redirects?: NextRedirect[];
  rewrites?: {
    beforeFiles: NextRewrite[];
    afterFiles: NextRewrite[];
    fallback: NextRewrite[];
  };
  headers?: NextHeader[];
}): PrecompiledConfigPatterns {
  const redirects = config.redirects ?? [];
  const rewrites = config.rewrites ?? { beforeFiles: [], afterFiles: [], fallback: [] };
  const headers = config.headers ?? [];

  return {
    redirects: redirects.map((rule) => compileConfigPattern(rule.source)),
    rewrites: {
      beforeFiles: rewrites.beforeFiles.map((rule) => compileConfigPattern(rule.source)),
      afterFiles: rewrites.afterFiles.map((rule) => compileConfigPattern(rule.source)),
      fallback: rewrites.fallback.map((rule) => compileConfigPattern(rule.source)),
    },
    headers: headers.map((rule) => compileHeaderSourcePattern(rule.source)),
  };
}

function serializeCompiledPattern(pattern: CompiledConfigPattern | null): string {
  if (!pattern) return "null";
  return `{ re: ${pattern.re.toString()}, paramNames: ${JSON.stringify(pattern.paramNames)} }`;
}

function serializeCompiledHeaderSource(pattern: RegExp | null): string {
  return pattern ? pattern.toString() : "null";
}

export function buildPrecompiledConfigCode(config: {
  redirects?: NextRedirect[];
  rewrites?: {
    beforeFiles: NextRewrite[];
    afterFiles: NextRewrite[];
    fallback: NextRewrite[];
  };
  headers?: NextHeader[];
}): {
  redirects: string;
  rewrites: string;
  headers: string;
} {
  const compiled = buildPrecompiledConfigPatterns(config);

  return {
    redirects: `[${compiled.redirects.map(serializeCompiledPattern).join(", ")}]`,
    rewrites:
      `{ beforeFiles: [${compiled.rewrites.beforeFiles.map(serializeCompiledPattern).join(", ")}], ` +
      `afterFiles: [${compiled.rewrites.afterFiles.map(serializeCompiledPattern).join(", ")}], ` +
      `fallback: [${compiled.rewrites.fallback.map(serializeCompiledPattern).join(", ")}] }`,
    headers: `[${compiled.headers.map(serializeCompiledHeaderSource).join(", ")}]`,
  };
}
