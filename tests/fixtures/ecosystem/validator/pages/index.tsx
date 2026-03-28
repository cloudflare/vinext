import isEmail from "validator/es/lib/isEmail.js";

export default function ValidatorPage() {
  const email = "test@example.com";
  const valid = isEmail(email);

  return (
    <div>
      <h1>Validator Test</h1>
      <p>Email: {email}</p>
      <p>Valid: {String(valid)}</p>
    </div>
  );
}
