export default async function SlowInterceptPhotoPage() {
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  return <p id="slow-intercept-message">Slow intercepted photo resolved</p>;
}
