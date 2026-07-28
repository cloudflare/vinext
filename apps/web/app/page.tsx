import { LandingMotion } from "./_components/landing-motion";
import { BenchmarkSection } from "./_components/landing/benchmark-section";
import { CompatibilitySection } from "./_components/landing/compatibility-section";
import { DeploySection } from "./_components/landing/deploy-section";
import { EngineSwapSection } from "./_components/landing/engine-swap-section";
import { GetStartedSection } from "./_components/landing/get-started-section";
import { HeroSection } from "./_components/landing/hero-section";
import { LandingAtmosphere } from "./_components/landing/landing-atmosphere";
import { landingRootStyle, type LandingStyle } from "./_components/landing/landing-styles";
import { getLandingStats, type LandingStats } from "./lib/landing-stats";

// ISR: headline numbers come from the same D1 data as /compatibility and
// /benchmarks; 5 minutes of staleness matches those pages.
export const revalidate = 300;

export function LandingPage({ stats }: { stats: LandingStats }) {
  return (
    <LandingMotion race={stats.buildSeconds} style={landingRootStyle}>
      <LandingAtmosphere />
      <div style={{ position: "relative", zIndex: "2" } satisfies LandingStyle}>
        <HeroSection />
        <EngineSwapSection />
        <BenchmarkSection stats={stats} />
      </div>
      <CompatibilitySection stats={stats} />
      <DeploySection />
      <GetStartedSection />
    </LandingMotion>
  );
}

export default async function HomePage() {
  return <LandingPage stats={await getLandingStats()} />;
}
