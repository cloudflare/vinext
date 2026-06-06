import Form from "next/form";
import { useRouter } from "next/router";

export default function FormTestPage() {
  const { query } = useRouter();
  const q = typeof query.q === "string" ? query.q : undefined;

  return (
    <main>
      <h1>Form Test</h1>

      {/* Basic GET form */}
      <Form action="/form-test" id="search-form">
        <input name="q" id="search-input" placeholder="Search..." />
        <button type="submit" id="search-button">
          Search
        </button>
      </Form>

      {/* replace prop: uses history.replace instead of push */}
      <Form action="/form-test" replace id="replace-form">
        <input name="q" id="replace-input" placeholder="Replace..." />
        <button type="submit" id="replace-button">
          Replace
        </button>
      </Form>

      {/* onSubmit preventDefault: should not navigate */}
      <Form
        action="/form-test"
        id="prevent-form"
        onSubmit={(e) => {
          e.preventDefault();
        }}
      >
        <input name="q" id="prevent-input" placeholder="Prevent..." defaultValue="blocked" />
        <button type="submit" id="prevent-button">
          Prevent
        </button>
      </Form>

      {q ? (
        <p id="search-result">Results for: {q}</p>
      ) : (
        <p id="search-empty">Enter a search term</p>
      )}
    </main>
  );
}
