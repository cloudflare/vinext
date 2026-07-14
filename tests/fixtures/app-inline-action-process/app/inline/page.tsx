export default function InlineActionPage() {
  async function submit() {
    "use server";
    return "inline-action-ok";
  }

  return (
    <form action={submit}>
      <button type="submit">Run inline action</button>
    </form>
  );
}
