import { RevalidateForm } from "./revalidate-form";

async function getData() {
  // Simulate an async data fetch that returns a unique timestamp
  await new Promise((resolve) => setTimeout(resolve, 50));
  return Date.now();
}

export default async function RevalidatePage() {
  const time = await getData();
  return (
    <div>
      <h1>Revalidate Test</h1>
      <div id="time">{time}</div>
      <RevalidateForm />
    </div>
  );
}
