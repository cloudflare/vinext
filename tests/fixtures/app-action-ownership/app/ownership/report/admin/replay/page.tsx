import { redirect } from "next/navigation";

export default function Page() {
  const accountToDelete = "alice";
  const deleteAccount = async () => {
    "use server";
    redirect(`/ownership/report/admin/secret?deleted=${accountToDelete}`);
  };

  return <form action={deleteAccount} />;
}
