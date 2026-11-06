import type { Metadata } from "next";
import { getSignalState } from "../data";

export async function generateMetadata(): Promise<Metadata> {
  return { title: `signal ${getSignalState()}` };
}

export default function Page() {
  return <p id="signal">{getSignalState()}</p>;
}
