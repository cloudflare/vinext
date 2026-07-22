interface RevalidateReasonProps {
  reason: string;
}

export default function RevalidateReasonPage({ reason }: RevalidateReasonProps) {
  return <p id="reason">revalidate reason: {reason}</p>;
}

// Mirrors Next.js's upstream test fixture
// (`test/e2e/revalidate-reason/pages/index.tsx`): records the
// `context.revalidateReason` passed to getStaticProps so callers can assert on
// the trigger type ("build" | "on-demand" | "stale").
export async function getStaticProps(context: {
  revalidateReason?: "build" | "on-demand" | "stale";
}) {
  return {
    props: {
      reason: context.revalidateReason ?? "",
    },
    // Long revalidate window so the entry never goes stale on its own during
    // the test — the only thing that should regenerate it is res.revalidate().
    revalidate: 3600,
  };
}
