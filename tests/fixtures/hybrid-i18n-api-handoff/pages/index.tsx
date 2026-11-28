import { useRouter } from "next/router";

export default function Home() {
  return <main data-locale={useRouter().locale}>Hybrid i18n API handoff fixture</main>;
}
