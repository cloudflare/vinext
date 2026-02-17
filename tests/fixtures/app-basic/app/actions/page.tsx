import { LikeButton } from "./like-button";
import { MessageForm } from "./message-form";

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
      </section>
    </main>
  );
}
