import { lazy, Suspense, type ComponentType } from "react";

const LateStyledContent = lazy(
  () =>
    new Promise<{ default: ComponentType }>((resolve) => {
      setTimeout(() => {
        resolve({
          default: function LateStyledContentImpl() {
            return (
              <span>
                late styled-jsx content
                <style jsx>{`
                  span {
                    background-color: rgb(1, 2, 3);
                  }
                `}</style>
              </span>
            );
          },
        });
      }, 150);
    }),
);

export default function StyledJsxStreamingPage({ source }: { source: string }) {
  return (
    <main>
      <p>styled-jsx streaming</p>
      <p data-testid="styled-jsx-data-source">{source}</p>
      <style jsx>{`
        p {
          color: blue;
        }
      `}</style>
      <Suspense fallback={<span>late styled-jsx fallback</span>}>
        <LateStyledContent />
      </Suspense>
    </main>
  );
}

export function getServerSideProps() {
  return { props: { source: "getServerSideProps" } };
}
