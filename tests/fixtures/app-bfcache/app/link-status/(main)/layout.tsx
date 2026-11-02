import { StatusLink } from "../status-link";

// Mirrors the app-router-playground route groups demo: the (checkout) group has
// no layout, so leaving for it hides this whole layout in a BFCache Activity.
export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <nav>
        <StatusLink href="/link-status" id="home-link" label="Home" />
        <StatusLink href="/link-status/checkout" id="checkout-link" label="Checkout" />
      </nav>
      <div>{children}</div>
    </>
  );
}
