import Form from "next/form";

export default function FormSourcePage() {
  return (
    <main style={{ minHeight: "200vh", paddingTop: "1200px" }}>
      <h1>Hybrid Pages Form</h1>

      <Form action="/form-search" id="basic-form">
        <input name="query" defaultValue="basic" />
        <button type="submit">Basic submit</button>
      </Form>

      <Form action="/missing-form-target" id="submitter-form">
        <input name="query" defaultValue="submitter" />
        <button type="submit" formAction="/form-search" name="source" value="button">
          Submitter action
        </button>
      </Form>

      <Form action="/form-search" replace id="replace-form">
        <input name="query" defaultValue="replace" />
        <button type="submit">Replace submit</button>
      </Form>

      <Form action="/form-search" scroll={false} id="no-scroll-form">
        <input name="query" defaultValue="no-scroll" />
        <button type="submit">No-scroll submit</button>
      </Form>

      <div
        id="native-submit-observer"
        onSubmit={(event) => {
          window.sessionStorage.setItem(
            "native-submit-default-prevented",
            String(event.defaultPrevented),
          );
          event.preventDefault();
        }}
      >
        <Form action="/form-search" id="native-form">
          <button type="submit" formMethod="post">
            Native submit
          </button>
        </Form>
      </div>
    </main>
  );
}
