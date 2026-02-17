import RedirectForm from "./redirect-form";

export default function ActionRedirectTest() {
  return (
    <div>
      <h1>Action Redirect Test</h1>
      <p>Clicking the button should invoke a server action that calls redirect().</p>
      <RedirectForm />
    </div>
  );
}
