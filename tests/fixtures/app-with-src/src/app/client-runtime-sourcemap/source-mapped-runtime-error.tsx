"use client";

type RuntimeSourcemapPayload = {
  alpha: string;
  beta: string;
  gamma: string;
  delta: string;
  epsilon: string;
  zeta: string;
  eta: string;
  theta: string;
};

const CLIENT_RUNTIME_SOURCEMAP_ERROR = "client-runtime-sourcemap: original TSX throw line";

function createPayload(): RuntimeSourcemapPayload {
  return {
    alpha: "alpha",
    beta: "beta",
    gamma: "gamma",
    delta: "delta",
    epsilon: "epsilon",
    zeta: "zeta",
    eta: "eta",
    theta: "theta",
  };
}

function raiseSourceMappedRuntimeError() {
  const payload = createPayload();

  if (payload.alpha === "alpha") {
    throw new Error(CLIENT_RUNTIME_SOURCEMAP_ERROR);
  }
}

export function SourceMappedRuntimeErrorButton() {
  return (
    <button
      type="button"
      data-testid="trigger-client-runtime-sourcemap-error"
      onClick={raiseSourceMappedRuntimeError}
    >
      Trigger runtime error
    </button>
  );
}
