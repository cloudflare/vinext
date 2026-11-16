import { useState } from "react";

import { formatCode } from "atlas-legacy-format";
import { ArrowGlyph, PersonGlyph } from "atlas-glyphs";

import { readCookie } from "@atlas/client-state/cookies";
import { DeskLayout } from "@atlas/workbench/desk-layout";
import { FilterBar } from "@atlas/workbench/filter-bar";
import { formatMinutes } from "@atlas/workbench/format/durations";
import { workbenchServerProps } from "@atlas/workbench/page-data";
import { StatusPill } from "@atlas/workbench/status-pill";
import { SummaryStrip } from "@atlas/workbench/summary-strip";

const SHIFTS = [
  { id: 7, name: "Morning", minutes: 480, crew: "north" },
  { id: 12, name: "Swing", minutes: 450, crew: "south" },
  { id: 31, name: "Night", minutes: 600, crew: "north" },
];

const RosterDesk = () => {
  const [crew, setCrew] = useState("all");
  const shifts = crew === "all" ? SHIFTS : SHIFTS.filter((shift) => shift.crew === crew);
  return (
    <DeskLayout desk="roster" title="Roster">
      <SummaryStrip figures={{ shifts: SHIFTS.length, crews: 2 }} />
      <FilterBar options={["all", "north", "south"]} onChange={setCrew} />
      <ul data-testid="roster-shifts" data-crew={crew}>
        {shifts.map((shift) => (
          <li key={shift.id}>
            <PersonGlyph /> {formatCode("SH", shift.id)} {shift.name} <ArrowGlyph />{" "}
            {formatMinutes(shift.minutes)}
          </li>
        ))}
      </ul>
      <p>Shell: {readCookie("atlas-shell") ?? "browser"}</p>
      <StatusPill label="roster" />
    </DeskLayout>
  );
};

export const getServerSideProps = workbenchServerProps("roster");

export default RosterDesk;
