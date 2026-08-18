import React from "react";
import ReactDOM from "react-dom";

export type ReactConditions = {
  react: "default" | "react-server";
  reactDom: "default" | "react-server";
};

function getReactCondition(): ReactConditions["react"] {
  const module = Object(React);
  return module.useState === undefined &&
    module.useEffect === undefined &&
    module.version !== undefined &&
    module.useId !== undefined
    ? "react-server"
    : "default";
}

function getReactDomCondition(): ReactConditions["reactDom"] {
  const module = Object(ReactDOM);
  return module.useFormState === undefined && module.preload !== undefined
    ? "react-server"
    : "default";
}

export function getReactConditions(): ReactConditions {
  return {
    react: getReactCondition(),
    reactDom: getReactDomCondition(),
  };
}

export function ReactConditionsView() {
  const conditions = getReactConditions();
  return (
    <>
      <p data-testid="react-condition">{conditions.react}</p>
      <p data-testid="react-dom-condition">{conditions.reactDom}</p>
    </>
  );
}
