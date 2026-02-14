import { Link } from "next-view-transitions";

export default function Home() {
  return (
    <div>
      <h1 data-testid="title" style={{ viewTransitionName: "title" }}>
        Home Page
      </h1>
      <p data-testid="content">Welcome to the view transitions demo.</p>
      <Link href="/about" data-testid="about-link">
        Go to About
      </Link>
    </div>
  );
}
