import Content from "../content/another.mdx";
import Counters from "../../components/counters";

export default function AnotherPage() {
  return (
    <>
      <Content />
      <h2 style={{ fontSize: "1.5rem", fontWeight: 600, marginTop: "2.5rem", marginBottom: "0.75rem" }}>
        Interactive Counter
      </h2>
      <Counters />
    </>
  );
}
