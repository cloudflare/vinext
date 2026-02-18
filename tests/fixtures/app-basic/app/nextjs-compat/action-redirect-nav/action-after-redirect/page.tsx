import { Form } from "./form";

export default async function ActionPage() {
  const randomNum = Math.random();
  return (
    <div>
      <h1 id="action-page">Action After Redirect</h1>
      <Form randomNum={randomNum} />
    </div>
  );
}
