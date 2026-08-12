import { currentWorkerEsmValue, WorkerEsmPage } from "../lib/worker-esm-page";

export function getServerSideProps() {
  return { props: { serverValue: currentWorkerEsmValue() } };
}

export default WorkerEsmPage;
