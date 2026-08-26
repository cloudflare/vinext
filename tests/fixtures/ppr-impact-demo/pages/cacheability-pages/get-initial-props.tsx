function PagesGetInitialProps({ value }: { value: string }) {
  return <p id="cacheability-result">{value}</p>;
}

PagesGetInitialProps.getInitialProps = async () => ({ value: "pages-get-initial-props" });

export default PagesGetInitialProps;
