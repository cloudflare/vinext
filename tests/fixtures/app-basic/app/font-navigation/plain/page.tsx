import Link from "next/link";

// No next/font here, so this route's document has no font <style> block.
export default function FontNavigationPlainPage() {
  return (
    <>
      <h1 data-testid="font-navigation-plain">Font navigation without a font</h1>
      <Link href="/font-navigation/b" data-testid="font-navigation-plain-link">
        To B
      </Link>
    </>
  );
}
