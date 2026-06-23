import Router from "../../packages/vinext/src/shims/router.js";

const instrumentationWindow = window as Window & {
  __INSTRUMENTATION_INITIAL_ROUTER_STATE__?: unknown;
};

instrumentationWindow.__INSTRUMENTATION_INITIAL_ROUTER_STATE__ = window.history.state;

export default Router;
