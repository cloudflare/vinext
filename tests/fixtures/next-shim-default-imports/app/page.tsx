// Next.js' `next/*` entrypoints are CommonJS, so a default import receives
// their `module.exports` in every layer.
import cache from "next/cache";
import constants from "next/constants";
import headers from "next/headers";
import og from "next/og";
import server from "next/server";
import { describeDefault } from "../describe-default";
import { ClientDefaults } from "./client-defaults";

const checks = {
  cache: describeDefault(cache, "unstable_cache"),
  constants: describeDefault(constants, "PHASE_PRODUCTION_BUILD"),
  headers: describeDefault(headers, "cookies"),
  og: describeDefault(og, "ImageResponse"),
  server: describeDefault(server, "NextResponse"),
};

export default function Page() {
  return (
    <ul>
      {Object.entries(checks).map(([name, shape]) => (
        <li key={name} data-layer="react-server" data-api={name} data-default={shape} />
      ))}
      <ClientDefaults />
    </ul>
  );
}
