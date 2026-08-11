export default function StyledJsxStreamingPage() {
  return (
    <main>
      <p>styled-jsx streaming</p>
      <style jsx>{`
        p {
          color: blue;
        }
      `}</style>
    </main>
  );
}
