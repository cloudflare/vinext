import { Component, type ReactNode } from "react";
// The boundary shows the app's own error page when a page throws while rendering.
import ServerError from "../pages/500";

export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <ServerError />;
    return <div data-marker="marker-error-boundary">{this.props.children}</div>;
  }
}
