import InsertedQueryRegistration from "./client";

export const dynamic = "error";
export const revalidate = 60;

export default function WorkerInsertedQueryPage() {
  return (
    <main>
      <InsertedQueryRegistration />
    </main>
  );
}
