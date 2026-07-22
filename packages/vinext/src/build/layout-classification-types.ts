/**
 * Shared types for the layout classification pipeline.
 *
 * Kept in a leaf module so both `report.ts` (which implements segment-config
 * classification) and `layout-classification.ts` (which composes the full
 * pipeline) can import them without forming a cycle.
 *
 * The wire contract between build and runtime is intentionally narrow: the
 * runtime only cares about the `"static" | "dynamic"` decision for a layout.
 * Reasons live in a sidecar structure so operators can trace how each
 * decision was made without bloating the hot-path payload.
 */

/**
 * Structured record of which classifier layer produced a decision and what
 * evidence it used. Kept as a discriminated union so each layer can carry
 * its own diagnostic shape without the consumer having to fall back to
 * stringly-typed `reason` fields.
 */
export type ClassificationReason =
  | {
      layer: "segment-config";
      key: "dynamic" | "revalidate";
      value: string | number;
    }
  | {
      layer: "module-graph";
      result: "static" | "needs-probe";
      firstShimMatch?: string;
    }
  | {
      layer: "runtime-probe";
      outcome: "static" | "dynamic";
      error?: string;
    }
  | { layer: "no-classifier" };

export type ModuleGraphStaticReason = {
  layer: "module-graph";
  result: "static";
  firstShimMatch?: string;
};

/**
 * Build-time classification outcome for a single layout. Tagged with `kind`
 * so callers can branch exhaustively and carry diagnostic reasons alongside
 * the decision.
 *
 * `absent` means no classifier layer had anything to say — the caller should
 * defer to the next layer (or to the runtime probe).
 */
export type LayoutBuildClassification =
  | { kind: "absent" }
  | { kind: "static"; reason: ClassificationReason }
  | { kind: "dynamic"; reason: ClassificationReason }
  | { kind: "needs-probe"; reason: ClassificationReason };
