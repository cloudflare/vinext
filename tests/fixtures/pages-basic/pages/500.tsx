// Custom pages/500.tsx — Next.js renders this when SSR/getServerSideProps
// throws. Without it, vinext would fall back to plain text "Internal Server
// Error". Used to regression-test issue #1458.
export default function Custom500() {
  return <p data-testid="custom-500">custom pages/500</p>;
}
