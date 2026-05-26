import Link from "next/link";

export default function RouterAutoscrollIndexPage() {
  return (
    <>
      {Array.from({ length: 500 }, (_, index) => (
        <div key={index}>{index}</div>
      ))}
      <Link href="/nextjs-compat/router-autoscroll/focus-target" id="to-focus-target">
        To focus target
      </Link>
    </>
  );
}
