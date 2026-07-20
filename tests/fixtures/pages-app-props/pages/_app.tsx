function App(props: any) {
  const { Component } = props;
  const hasPageProps = Object.hasOwn(props, "pageProps");

  if (typeof window !== "undefined") {
    const records = ((window as any).__APP_PROPS_RECORDS__ ??= []);
    const record = {
      pathname: window.location.pathname,
      hasPageProps,
    };
    const previous = records.at(-1);
    if (previous?.pathname !== record.pathname || previous?.hasPageProps !== record.hasPageProps) {
      records.push(record);
    }
  }

  return (
    <>
      <nav>
        <button id="to-missing" type="button" onClick={() => props.router.push("/missing")}>
          missing
        </button>{" "}
        <button id="to-missing-two" type="button" onClick={() => props.router.push("/missing-two")}>
          missing two
        </button>{" "}
        <button
          id="to-with-page-props"
          type="button"
          onClick={() => props.router.push("/with-page-props")}
        >
          app props
        </button>{" "}
        <button id="to-page-gip" type="button" onClick={() => props.router.push("/page-gip")}>
          page getInitialProps
        </button>{" "}
        <button
          id="to-null-page-props"
          type="button"
          onClick={() => props.router.push("/null-page-props")}
        >
          null pageProps
        </button>{" "}
        <button
          id="to-string-page-props"
          type="button"
          onClick={() => props.router.push("/string-page-props")}
        >
          string pageProps
        </button>{" "}
        <button id="to-gsp-string" type="button" onClick={() => props.router.push("/gsp-string")}>
          gSP string pageProps
        </button>{" "}
        <button id="to-gssp-array" type="button" onClick={() => props.router.push("/gssp-array")}>
          gSSP array pageProps
        </button>
      </nav>
      <div id="has-page-props">{String(hasPageProps)}</div>
      <div id="page-props-json">
        {hasPageProps ? (JSON.stringify(props.pageProps) ?? "undefined") : "absent"}
      </div>
      <div id="app-extra">{props.appExtra}</div>
      <div id="app-router-pathname">{props.router?.pathname ?? "missing-router"}</div>
      <Component {...(props.pageProps ?? {})} />
    </>
  );
}

App.getInitialProps = async ({ Component, ctx }: any) => {
  if (ctx.pathname === "/missing" || ctx.pathname === "/missing-two") {
    return { appExtra: "custom-extra" };
  }
  if (ctx.pathname === "/null-page-props") {
    return { appExtra: "custom-extra", pageProps: null };
  }
  if (ctx.pathname === "/string-page-props") {
    return { appExtra: "custom-extra", pageProps: "hi" };
  }
  if (ctx.pathname === "/gsp-string") {
    return { appExtra: "custom-extra", pageProps: "hi" };
  }
  if (ctx.pathname === "/gssp-array") {
    return { appExtra: "custom-extra", pageProps: ["first", "second"] };
  }

  const pageProps = Component.getInitialProps
    ? await Component.getInitialProps(ctx)
    : { fromApp: "from-app" };
  return { appExtra: "custom-extra", pageProps };
};

export default App;
