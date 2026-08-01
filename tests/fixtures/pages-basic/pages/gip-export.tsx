function GipExport({ label }: { label: string }) {
  return <div id="gip-export">{label}</div>;
}

// Next.js runs getInitialProps during `output: "export"` and only warns about it
// (errors/get-initial-props-export); getServerSideProps is the hard error. This
// page must therefore still emit gip-export.html.
GipExport.getInitialProps = async () => ({ label: "exported-gip" });

export default GipExport;
