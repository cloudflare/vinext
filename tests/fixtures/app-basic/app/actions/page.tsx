import { LikeButton } from "./like-button";
import { MessageForm } from "./message-form";
import { notFoundAction } from "./actions";

export default function ActionsPage() {
  return (
    <main>
      <h1>Server Actions</h1>
      <p>This page tests server actions.</p>
      <section>
        <h2>Like Button</h2>
        <LikeButton />
      </section>
      <section>
        <h2>Message Form</h2>
        <MessageForm />
        <form action={notFoundAction}>
          <button type="submit">Trigger not found</button>
        </form>
      </section>
    </main>
  );
}
