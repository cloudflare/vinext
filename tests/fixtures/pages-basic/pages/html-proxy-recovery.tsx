import type { GetServerSidePropsContext } from "next";
import Head from "next/head";
import {
  enterHtmlProxyRace,
  enterInlineModuleRace,
  getNonModuleVariant,
} from "../html-proxy-race-state";

export async function getServerSideProps({ query }: GetServerSidePropsContext) {
  const raceId = Array.isArray(query.race) ? query.race[0] : query.race;
  if (raceId && (await enterHtmlProxyRace(raceId)) === "error") {
    throw new Error("intentional delayed render failure");
  }

  const inlineRaceId = Array.isArray(query.inlineRace) ? query.inlineRace[0] : query.inlineRace;
  const inlineModuleVariant = inlineRaceId ? await enterInlineModuleRace(inlineRaceId) : null;
  const preHookProxy = query.preHookProxy === "1";
  const dataRaceId = Array.isArray(query.dataRace) ? query.dataRace[0] : query.dataRace;
  const message = dataRaceId ? getNonModuleVariant(dataRaceId) : "route render recovered";

  return { props: { inlineModuleVariant, message, preHookProxy } };
}

export default function HtmlProxyRecoveryPage({
  inlineModuleVariant,
  message,
  preHookProxy,
}: {
  inlineModuleVariant: "first" | "second" | null;
  message: string;
  preHookProxy: boolean;
}) {
  return (
    <>
      {inlineModuleVariant ? (
        <Head>
          <script
            type="module"
            dangerouslySetInnerHTML={{
              __html: `import { htmlProxyRelativeValue } from "./html-proxy-relative.ts";
window.__HTML_PROXY_INLINE_VARIANT__ = ${JSON.stringify(inlineModuleVariant)} + ":" + htmlProxyRelativeValue;`,
            }}
          />
        </Head>
      ) : null}
      {preHookProxy ? (
        <Head>
          <script
            type="module"
            dangerouslySetInnerHTML={{
              __html:
                'window.__HTML_PROXY_PRE_HOOK_SEQUENCE__ = "__VINEXT_HTML_PROXY_PRE_HOOK_SEQUENCE__";',
            }}
          />
        </Head>
      ) : null}
      <p id="html-proxy-recovery">{message}</p>
    </>
  );
}
