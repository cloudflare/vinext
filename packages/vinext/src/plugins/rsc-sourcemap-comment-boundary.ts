import type { Plugin } from "vite";

const SOURCE_MAPPING_COMMENT_STATEMENT_BOUNDARY_RE =
  /(^|[\r\n])(\s*\/\/# sourceMappingURL=[^\r\n]*?\.map(?:[?#][^\r\n]*?)?)(?=(?:import|export)\s)/g;

export function repairSourceMappingCommentStatementBoundary(code: string): string | null {
  if (!code.includes("sourceMappingURL=")) return null;

  const repaired = code.replace(SOURCE_MAPPING_COMMENT_STATEMENT_BOUNDARY_RE, "$1$2\n");
  return repaired === code ? null : repaired;
}

export function createRscSourceMappingCommentBoundaryPlugin(): Plugin {
  return {
    name: "vinext:rsc-sourcemap-comment-boundary",
    enforce: "post",
    transform: {
      order: "post",
      filter: { code: "sourceMappingURL=" },
      handler(code) {
        if (this.environment?.name !== "rsc") return null;

        const repaired = repairSourceMappingCommentStatementBoundary(code);
        return repaired ? { code: repaired, map: null } : null;
      },
    },
  };
}
