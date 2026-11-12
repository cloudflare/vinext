export const revalidate = 1;

export default function Page() {
  return (
    <>
      <img src="/hero.png" fetchPriority="high" alt="" />
      <p id="rendered-at">{Date.now()}</p>
    </>
  );
}
