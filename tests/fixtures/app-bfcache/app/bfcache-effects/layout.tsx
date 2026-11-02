import Link from "next/link";
import { EffectProbe } from "./effect-probe";

const base = "/bfcache-effects";

export default function EffectsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <nav>
        <ul>
          <li>
            <Link href={base}>Home</Link>
          </li>
          <li>
            <Link href={`${base}/chat`}>Chat lobby</Link>
          </li>
          {["a", "b", "c", "d", "e"].map((id) => (
            <li key={id}>
              <Link href={`${base}/chat/${id}`}>Chat {id}</Link>
            </li>
          ))}
          <li>
            <Link href={`${base}/chat/a?from=search`}>Chat a (with search param)</Link>
          </li>
          <li>
            <Link href={`${base}/gallery`}>Gallery</Link>
          </li>
          {["1", "2", "3"].map((id) => (
            <li key={`photo-${id}`}>
              <Link href={`${base}/gallery/photo/${id}`}>Photo {id}</Link>
            </li>
          ))}
          <li>
            <Link href={`${base}/shots`}>Shots</Link>
          </li>
          {["1", "2", "3"].map((id) => (
            <li key={`shot-${id}`}>
              <Link href={`${base}/shots/${id}`}>Shot {id}</Link>
            </li>
          ))}
          {["a", "b"].map((id) => (
            <li key={`room-${id}`}>
              <Link href={`${base}/rooms/${id}`}>Room {id}</Link>
            </li>
          ))}
          {["1", "2"].map((q) => (
            <li key={q}>
              <Link href={`${base}/search?q=${q}`}>Search {q}</Link>
            </li>
          ))}
        </ul>
      </nav>
      <EffectProbe name="shell" />
      <div>{children}</div>
    </>
  );
}
