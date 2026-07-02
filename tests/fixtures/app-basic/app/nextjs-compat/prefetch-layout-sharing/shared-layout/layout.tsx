import { Suspense } from "react";
import { connection } from "next/server";

export default function PrefetchLayoutSharingSharedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <main>
      <h2>Shared layout</h2>
      <DebugRenderKind />
      <Suspense fallback={<div>Loading shared layout dynamic content...</div>}>
        <DynamicLayoutContent />
      </Suspense>
      {children}
    </main>
  );
}

async function DynamicLayoutContent() {
  await connection();
  return <div id="dynamic-content-layout">Dynamic content from layout</div>;
}

function DebugRenderKind() {
  const { workUnitAsyncStorage } =
    require("next/dist/server/app-render/work-unit-async-storage.external") as {
      workUnitAsyncStorage: { getStore(): { type?: string } | undefined };
    };
  const workUnitStore = workUnitAsyncStorage.getStore();

  return (
    <div id="work-unit-store-type">workUnitStore.type: {workUnitStore?.type ?? "missing"}</div>
  );
}
