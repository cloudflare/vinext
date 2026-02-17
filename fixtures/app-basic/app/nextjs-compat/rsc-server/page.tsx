import { ClientChild } from "./client-child";
async function getData() {
  return { message: "from server", timestamp: Date.now() };
}
export default async function Page() {
  const data = await getData();
  return (
    <div>
      <h1 id="server-rendered">Server Component</h1>
      <p id="server-message">{data.message}</p>
      <ClientChild greeting="hello from server" />
    </div>
  );
}
