import { Suspense } from "react";
import { externalElementStyles, externalStyles } from "../styles/styled-jsx-external";

async function LateStyledContent() {
  await new Promise((resolve) => setTimeout(resolve, 20));

  return (
    <div className={externalStyles.className}>
      {externalStyles.styles}
      <style jsx>{externalElementStyles}</style>
      <style jsx>{`
        p {
          color: blue;
        }
      `}</style>
      <p id="late-styled-content" className="external external-element">
        styled-jsx streaming parity
      </p>
    </div>
  );
}

export default function StyledJsxStreamingPage() {
  return (
    <main id="styled-jsx-shell">
      <Suspense fallback={<p id="styled-jsx-fallback">loading styles</p>}>
        <LateStyledContent />
      </Suspense>
    </main>
  );
}
