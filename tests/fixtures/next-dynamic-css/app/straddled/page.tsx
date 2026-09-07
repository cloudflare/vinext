import a from "./a.module.css";
import "./global.css";
import b from "./b.module.css";

export default function StraddledOrderPage() {
  return (
    <p id="straddled-order" className={`${a.class} straddled-order ${b.class}`}>
      Later CSS modules win
    </p>
  );
}
