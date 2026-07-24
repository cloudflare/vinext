import { useEffect, useState } from "react";

import Head from "next/head";

import { readCookie } from "@atlas/client-state/cookies";

import styles from "./client-flags.module.css";

/**
 * Support-tooling page with NO data-fetching function of any kind — no
 * getServerSideProps, no page-level getInitialProps. (It still renders
 * through the app shell's getInitialProps, since a custom App opts every
 * page out of automatic static optimisation.) Pure client behaviour: toggles
 * that pin routing/debug cookies for the current browser.
 */

const cookieNameBackendPin = "ATLAS-BACKEND-PIN";
const cookieValueBackendPrimary = "PRIMARY";
const cookieValueBackendCanary = "CANARY";

const cookieNameSurface = "atlas-surface";
const cookieValueSurfaceEmbedded = "embedded";

const setFlagCookie = (name: string, value: string) => {
  document.cookie = `${name}=${value}; path=/`;
};

const clearFlagCookie = (name: string) => {
  document.cookie = `${name}=; path=/; max-age=0`;
};

const ClientFlagsPage = () => {
  const [backendPin, setBackendPin] = useState("");
  const [isEmbeddedSurface, setEmbeddedSurface] = useState(false);

  // Cookie state settles after hydration — the server render has no cookies,
  // so reading them during render would tear the hydration pass.
  useEffect(() => {
    setBackendPin(readCookie(cookieNameBackendPin) ?? "");
    setEmbeddedSurface(readCookie(cookieNameSurface) === cookieValueSurfaceEmbedded);
  }, []);

  const pinBackend = (value: string) => {
    if (value) {
      setFlagCookie(cookieNameBackendPin, value);
    } else {
      clearFlagCookie(cookieNameBackendPin);
    }
    setBackendPin(value);
  };

  return (
    <>
      <Head>
        <title>Client flags | atlas</title>
        <meta name="robots" content="noindex" />
      </Head>
      <section className={styles.panel} data-testid="client-flags">
        <h1>Client flags</h1>

        <fieldset className={styles.group}>
          <legend>Backend pin</legend>
          {[
            ["", "unpinned"],
            [cookieValueBackendPrimary, "primary"],
            [cookieValueBackendCanary, "canary"],
          ].map(([value, label]) => (
            <label key={label}>
              <input
                type="radio"
                name="backend-pin"
                value={value}
                checked={backendPin === value}
                onChange={() => pinBackend(value)}
              />
              {label}
            </label>
          ))}
        </fieldset>

        <fieldset className={styles.group}>
          <legend>Surface</legend>
          <label>
            <input
              type="checkbox"
              checked={isEmbeddedSurface}
              onChange={(event) => {
                if (event.target.checked) {
                  setFlagCookie(cookieNameSurface, cookieValueSurfaceEmbedded);
                } else {
                  clearFlagCookie(cookieNameSurface);
                }
                setEmbeddedSurface(event.target.checked);
              }}
            />
            embedded surface
          </label>
        </fieldset>

        <p data-testid="pinned-backend" data-pin={backendPin || "none"}>
          Pinned backend: {backendPin || "none"}
        </p>
      </section>
    </>
  );
};

export default ClientFlagsPage;
