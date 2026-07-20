function PageGetInitialProps({ fromPage }: { fromPage: string }) {
  return <div id="page-content">{fromPage}</div>;
}

PageGetInitialProps.getInitialProps = async () => ({ fromPage: "from-page" });

export default PageGetInitialProps;
