function App(props: any) {
  const { Component } = props;

  return (
    <>
      <div id="has-page-props">{String(Object.hasOwn(props, "pageProps"))}</div>
      <div id="app-extra">{props.appExtra}</div>
      <Component {...(props.pageProps ?? {})} />
    </>
  );
}

App.getInitialProps = async ({ Component, ctx }: any) => {
  if (ctx.pathname === "/missing") {
    return { appExtra: "custom-extra" };
  }

  const pageProps = Component.getInitialProps
    ? await Component.getInitialProps(ctx)
    : { fromApp: "from-app" };
  return { appExtra: "custom-extra", pageProps };
};

export default App;
