import { useRouter } from "next/router";

// Next.js routes a rejected path on before it renders any error page. This 404
// fails for any path but its own and the one `isr/[...rest]` answers with
// `notFound`, so rendering it first would turn a path another route answers
// into a 500.
export default function NotFound() {
  const { asPath } = useRouter();
  if (asPath !== "/404" && asPath !== "/isr/rest-not-found") {
    throw new Error(`404 page rendered for ${asPath}`);
  }
  return <div id="route">not found</div>;
}
