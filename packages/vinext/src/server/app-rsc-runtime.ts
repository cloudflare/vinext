import {
  createClientManifest,
  createServerManifest,
  loadServerAction,
  setRequireModule,
} from "@vitejs/plugin-rsc/core/rsc";
import * as ReactServer from "@vitejs/plugin-rsc/vendor/react-server-dom/server.edge";
import serverReferences from "virtual:vite-rsc/server-references";

type ClientReferenceMetadata = {
  id: string;
  name: string;
};

type RenderExtraOptions = {
  onClientReference?: (metadata: ClientReferenceMetadata) => void;
};

function toReferenceValidationVirtual(id: string): string {
  return `virtual:vite-rsc/reference-validation?type=server&id=${encodeURIComponent(id)}&lang.js`;
}

setRequireModule({
  async load(id: string) {
    if (!import.meta.env.__vite_rsc_build__) {
      await import(
        /* @vite-ignore */
        "/@id/__x00__" + toReferenceValidationVirtual(id)
      );
      return import(
        /* @vite-ignore */
        id
      );
    }

    const importServerReference = serverReferences[id];
    if (!importServerReference) {
      throw new Error(`server reference not found '${id}'`);
    }
    return importServerReference();
  },
});

export function renderToReadableStream(
  data: unknown,
  options?: unknown,
  extraOptions?: RenderExtraOptions,
): ReadableStream<Uint8Array> {
  return ReactServer.renderToReadableStream(
    data,
    createClientManifest({
      onClientReference: extraOptions?.onClientReference,
    }),
    options,
  );
}

export const decodeReply = (body: string | FormData, options?: unknown): Promise<unknown[]> =>
  ReactServer.decodeReply(body, createServerManifest(), options);

export function decodeAction(body: FormData): Promise<() => Promise<void>> {
  return ReactServer.decodeAction(body, createServerManifest());
}

export function decodeFormState(actionResult: unknown, body: FormData): Promise<unknown> {
  return ReactServer.decodeFormState(actionResult, body, createServerManifest());
}

export const createTemporaryReferenceSet = ReactServer.createTemporaryReferenceSet;
export const registerClientReference = ReactServer.registerClientReference;
export const registerServerReference = ReactServer.registerServerReference;
export { loadServerAction, setRequireModule };
