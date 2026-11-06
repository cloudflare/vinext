import Link from "next/link";
import {
  PagesRedirectActionButton,
  PushAndRefreshButton,
  RedirectActionButton,
  RefreshButton,
  RevalidateActionButton,
} from "./refresh-button";

export default function RefreshDuringNavigationLayout({ children }: { children: React.ReactNode }) {
  return (
    <main>
      <nav>
        <Link href="/refresh-during-navigation/destination" prefetch={false} id="destination-link">
          Destination
        </Link>{" "}
        <Link href="/refresh-during-navigation/streaming" prefetch={false} id="streaming-link">
          Streaming
        </Link>{" "}
        <Link href="/refresh-during-navigation/slow-commit" prefetch={false} id="slow-commit-link">
          Slow commit
        </Link>{" "}
        <Link href="/old-school" prefetch={false} id="pages-link">
          Pages
        </Link>{" "}
        <RefreshButton /> <PushAndRefreshButton /> <RedirectActionButton />{" "}
        <RevalidateActionButton /> <PagesRedirectActionButton />
      </nav>
      {children}
    </main>
  );
}
