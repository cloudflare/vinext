import a from "./a.module.css";
import Intermediate from "./intermediate";
import b from "./b.module.css";

export default function TransitiveOrderPage() {
  return (
    <>
      <Intermediate />
      <p id="transitive-before" className={`${a.class} transitive-order`}>
        Transitive global imports follow earlier modules
      </p>
      <p id="transitive-after" className={`transitive-order ${b.class}`}>
        Later modules follow transitive global imports
      </p>
    </>
  );
}
