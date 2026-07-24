import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

import { emitBeacon } from "../../beacon/emit";

type CrashGuardProps = {
  viewKind: string;
  templateKind?: string;
  children: ReactNode;
};

type CrashGuardState = {
  crashed: boolean;
};

class CrashGuard extends Component<CrashGuardProps, CrashGuardState> {
  state: CrashGuardState = { crashed: false };

  static getDerivedStateFromError(): CrashGuardState {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    emitBeacon("client-render-crash", {
      message: error.message,
      componentStack: info.componentStack,
      viewKind: this.props.viewKind,
      templateKind: this.props.templateKind,
    });
  }

  render() {
    if (this.state.crashed) {
      return (
        <div data-testid="crash-guard-fallback">
          <h1>This view failed to render.</h1>
          <a href="/">Back to the front</a>
        </div>
      );
    }

    return this.props.children;
  }
}

export default CrashGuard;
