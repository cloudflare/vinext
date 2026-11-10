"use client";

import { redirectAction, saveAction } from "./actions";

export default function Buttons() {
  return (
    <div>
      <button type="button" data-testid="save-btn" onClick={() => void saveAction()}>
        Save
      </button>
      <button type="button" data-testid="redirect-btn" onClick={() => void redirectAction()}>
        Delete and redirect
      </button>
    </div>
  );
}
