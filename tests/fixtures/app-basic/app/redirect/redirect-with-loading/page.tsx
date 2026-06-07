import { redirect } from "next/navigation";

export default async function Page(): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, 1000));

  redirect("/redirect/result");
}
