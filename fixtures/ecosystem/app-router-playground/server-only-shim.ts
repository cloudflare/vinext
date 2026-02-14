// server-only shim for nextcompat
// In Next.js, importing 'server-only' throws at build time if the module
// is included in a client bundle. In nextcompat, the RSC/SSR environments
// handle this naturally — server-only modules stay on the server.
// This empty shim prevents import errors.
export {};
