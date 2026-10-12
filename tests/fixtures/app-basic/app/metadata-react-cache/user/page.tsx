import type { Metadata } from "next";
import { getUser } from "../data";

export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  return { title: `user ${await getUser()}` };
}

export default async function Page() {
  return <p id="user">{await getUser()}</p>;
}
