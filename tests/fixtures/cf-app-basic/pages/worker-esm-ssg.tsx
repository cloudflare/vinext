import { currentWorkerEsmValue, WorkerEsmPage } from "../lib/worker-esm-page";

export function getStaticProps() {
  return { props: { serverValue: currentWorkerEsmValue() } };
}

export default WorkerEsmPage;
