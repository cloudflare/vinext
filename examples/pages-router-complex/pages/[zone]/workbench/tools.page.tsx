import { useState } from "react";

import { DeskLayout } from "@atlas/workbench/desk-layout";
import { toCsv } from "@atlas/workbench/export/csv";
import { workbenchServerProps } from "@atlas/workbench/page-data";

const ToolsDesk = () => {
  const [presets, setPresets] = useState<string[]>([]);
  const [diff, setDiff] = useState<string[]>([]);
  return (
    <DeskLayout desk="tools" title="Tools">
      <pre data-testid="tools-csv">{toCsv([["tool", "state"], ["diff", "ready"]])}</pre>
      <button
        type="button"
        data-testid="load-presets"
        onClick={async () => {
          const { default: data } = await import("@atlas/workbench/tools/presets.json");
          setPresets(data.presets.map((preset) => preset.label));
        }}
      >
        Load presets
      </button>
      <ul data-testid="presets">
        {presets.map((label) => (
          <li key={label}>{label}</li>
        ))}
      </ul>
      <button
        type="button"
        data-testid="run-diff"
        onClick={async () => {
          const { diffSchedules } = await import("@atlas/workbench/tools/diff-engine");
          setDiff(diffSchedules([480, 450], [500, 420]));
        }}
      >
        Diff schedules
      </button>
      <p data-testid="diff-output">{diff.join(" ")}</p>
    </DeskLayout>
  );
};

export const getServerSideProps = workbenchServerProps("tools");

export default ToolsDesk;
