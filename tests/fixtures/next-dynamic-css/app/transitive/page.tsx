import a from "./a.module.css";
import Intermediate from "./intermediate";
import b from "./b.module.css";

export default function TransitiveOrderPage() {
  return (
    <>
      <Intermediate />
      <p id="transitive-order" className={`${a.class} transitive-order ${b.class}`}>
        Transitive global imports retain total order
      </p>
    </>
  );
}
