// Only pages/server-only-data-export.tsx's getServerSideProps imports this
// module. The data export is stripped from the client build before its imports
// resolve, so the server-only marker must not fail the client build and the
// token must not appear in any public client chunk.
import "server-only";

export const SERVER_ONLY_DATA_TOKEN = "VINEXT_SERVER_ONLY_DATA_TOKEN_9b47d2c1";
