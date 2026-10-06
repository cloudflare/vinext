import type { Metadata } from "next";
import { getLive } from "../data";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `live ${await getLive()}` };
}

export default function Page() {
  return <p id="connection-page">connection page</p>;
}
