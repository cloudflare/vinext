import { Button } from "../components/ui/button";
import { DialogDemo } from "./dialog-demo";
import { DropdownDemo } from "./dropdown-demo";

export default function Home() {
  return (
    <div>
      <h1>shadcn test</h1>
      <p data-testid="ssr-content">Server-rendered content</p>

      <section data-testid="button-section">
        <h2>Button</h2>
        <Button data-testid="default-button">Default Button</Button>
        <Button variant="destructive" data-testid="destructive-button">
          Destructive
        </Button>
        <Button variant="outline" data-testid="outline-button">
          Outline
        </Button>
        <Button variant="secondary" data-testid="secondary-button">
          Secondary
        </Button>
        <Button variant="ghost" data-testid="ghost-button">
          Ghost
        </Button>
        <Button variant="link" data-testid="link-button">
          Link
        </Button>
      </section>

      <section data-testid="dialog-section">
        <h2>Dialog</h2>
        <DialogDemo />
      </section>

      <section data-testid="dropdown-section">
        <h2>Dropdown Menu</h2>
        <DropdownDemo />
      </section>
    </div>
  );
}
