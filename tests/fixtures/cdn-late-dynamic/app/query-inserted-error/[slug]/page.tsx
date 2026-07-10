import InsertedQueryRegistration from "./client";

export const dynamic = "error";
export const revalidate = 60;

export default function InsertedQueryPage() {
  return (
    <main>
      <h1>Inserted client search params</h1>
      <InsertedQueryRegistration />
    </main>
  );
}
