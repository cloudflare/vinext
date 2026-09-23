// Ported from Next.js: test/e2e/styled-jsx-dynamic/components/Header.js
export default function Header({ bg, fg }) {
  return (
    <header>
      <style jsx>{`
        header {
          background-color: ${bg};
          color: ${fg};
          padding: 1rem;
        }
      `}</style>
      <span>Header</span>
    </header>
  );
}
