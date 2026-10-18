// Starts loading the item without awaiting it, so for an unknown id the promise
// rejects while getServerSideProps is still awaiting other work. The rejection
// is unhandled for a few ticks, then handled by the later `await`. A running
// server must survive it.
async function getItem(id: string) {
  await new Promise((resolve) => setTimeout(resolve, 1));
  if (id !== "1") throw new Error(`item not found: ${id}`);
  return { name: "Item 1" };
}

export default function PreloadRejectionPage({ name }: { name: string }) {
  return <p id="item-name">{name}</p>;
}

export async function getServerSideProps({ params }: { params: { id: string } }) {
  const item = getItem(params.id);
  await new Promise((resolve) => setTimeout(resolve, 25));
  try {
    return { props: { name: (await item).name } };
  } catch {
    return { notFound: true };
  }
}
