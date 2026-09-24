// Ported from Next.js: test/e2e/styled-jsx-dynamic/components/DynamicStyled.js
export default function DynamicStyled({ color }) {
  return (
    <div>
      <style jsx>{`
        p {
          color: ${color};
        }
      `}</style>
      <p>dynamic styled</p>
    </div>
  );
}
