import { useRouter } from "next/router";

export default function ErrorPage() {
  const { locale } = useRouter();
  return (
    <>
      <p id="custom-error">custom error page</p>
      <p id="locale">{locale ?? "none"}</p>
    </>
  );
}
