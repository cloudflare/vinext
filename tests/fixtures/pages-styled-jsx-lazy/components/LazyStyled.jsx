// The only styled-jsx module in this app, and it is only loaded lazily.
export default function LazyStyled() {
  return (
    <div>
      <style jsx>{`
        p {
          color: orange;
        }
      `}</style>
      <p id="lazy-styled">lazy styled</p>
    </div>
  );
}
