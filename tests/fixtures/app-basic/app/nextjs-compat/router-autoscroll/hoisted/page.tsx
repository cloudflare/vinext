export default function HoistedPage() {
  return (
    <>
      <style href="custom-stylesheet" precedence="alpha" />
      <div id="hoisted-page">Hoisted page</div>
      {Array.from({ length: 500 }, (_, index) => (
        <div key={index}>{index}</div>
      ))}
    </>
  );
}
