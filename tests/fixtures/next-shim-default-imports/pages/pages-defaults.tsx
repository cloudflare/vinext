import cache from "next/cache";
import compatRouter from "next/compat/router";
import constants from "next/constants";
import navigation from "next/navigation";
import offline from "next/offline";
import webVitals from "next/web-vitals";
import { describeDefault } from "../describe-default";

const checks = {
  cache: describeDefault(cache, "unstable_cache"),
  "compat/router": describeDefault(compatRouter, "useRouter"),
  constants: describeDefault(constants, "PHASE_PRODUCTION_BUILD"),
  navigation: describeDefault(navigation, "useRouter"),
  offline: describeDefault(offline, "useOffline"),
  "web-vitals": describeDefault(webVitals, "useReportWebVitals"),
};

export default function Page() {
  return (
    <ul>
      {Object.entries(checks).map(([name, shape]) => (
        <li key={name} data-layer="pages" data-api={name} data-default={shape} />
      ))}
    </ul>
  );
}
