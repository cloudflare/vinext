import { Suspense } from "react";

export const dynamic = "force-dynamic";

function wait(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function generateMetadata() {
  await wait(300);
  return {
    title: "Delayed bot metadata",
    description: "Bot metadata resolved before the body shell",
  };
}

async function BotContent() {
  await wait(600);

  return <p id="metadata-streaming-bot-content">bot dynamic content</p>;
}

export default function MetadataStreamingBotPage() {
  return (
    <main data-testid="metadata-streaming-bot-shell">
      <p>Metadata streaming bot shell</p>
      <Suspense fallback={<p id="metadata-streaming-bot-fallback">bot loading</p>}>
        <BotContent />
      </Suspense>
    </main>
  );
}
