import { recordDomainRevalidateContext } from "../revalidate-state";

export function getStaticProps({ locale, defaultLocale, revalidateReason }) {
  const state = recordDomainRevalidateContext({
    locale,
    defaultLocale,
    reason: revalidateReason,
  });
  return {
    props: {
      locale,
      defaultLocale,
      generation: state.generation,
      reason: state.reason,
      renderedAt: Date.now(),
    },
    revalidate: 60,
  };
}

export default function IsrAbout({ locale, defaultLocale, generation, reason, renderedAt }) {
  return (
    <main>
      <h1>ISR About</h1>
      <p id="locale">{locale}</p>
      <p id="defaultLocale">{defaultLocale}</p>
      <p id="generation">{generation}</p>
      <p id="reason">{reason}</p>
      <p id="renderedAt">{renderedAt}</p>
    </main>
  );
}
