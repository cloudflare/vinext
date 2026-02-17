import { SearchForm } from "./search-form";

export default function Home() {
  return (
    <div>
      <h1>nuqs test</h1>
      <p data-testid="ssr-content">Server-rendered content</p>
      <SearchForm />
    </div>
  );
}
