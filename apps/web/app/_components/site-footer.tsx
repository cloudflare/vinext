import { Text } from "@cloudflare/kumo/components/text";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-kumo-hairline">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-center px-6 py-6">
        <Text variant="secondary" size="sm">
          vinext is an open-source{" "}
          <a
            href="https://www.cloudflare.com/"
            className="underline underline-offset-2 hover:text-kumo-default"
          >
            Cloudflare
          </a>{" "}
          project under active development. Issues and PRs are welcome.
        </Text>
      </div>
    </footer>
  );
}
