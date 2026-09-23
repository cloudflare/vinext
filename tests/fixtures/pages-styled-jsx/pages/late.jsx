import React, { Suspense, lazy } from "react";
import { lateAccent } from "../components/styled-jsx-external";

function LateStyledContent() {
  return (
    <div className={lateAccent.className}>
      {lateAccent.styles}
      <style jsx>{`
        p {
          color: purple;
        }
      `}</style>
      <p id="styled-jsx-late" className={`late-accent ${lateAccent.className}`}>
        late styled
      </p>
    </div>
  );
}

function createLateStyledContent() {
  return lazy(
    () =>
      new Promise((resolve) => {
        // Resolve after the shell so the boundary streams in after the
        // document head has already been built.
        setTimeout(() => resolve({ default: LateStyledContent }), 50);
      }),
  );
}

export default function StyledJsxLatePage() {
  // A fresh lazy component per render keeps the boundary pending on every
  // request instead of only the first one.
  const [LateStyled] = React.useState(createLateStyledContent);
  return (
    <main>
      <style jsx>{`
        main {
          padding: 1px;
        }
      `}</style>
      <Suspense fallback={<p id="styled-jsx-late-fallback">loading</p>}>
        <LateStyled />
      </Suspense>
    </main>
  );
}
