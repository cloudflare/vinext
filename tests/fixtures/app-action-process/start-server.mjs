import { pathToFileURL } from "node:url";

const prodServerPath = process.argv[2];
const outDir = process.argv[3];
if (!prodServerPath || !outDir) {
  throw new Error("Expected production server module and app output paths");
}

const { startProdServer } = await import(pathToFileURL(prodServerPath).href);
const { server, port } = await startProdServer({
  host: "127.0.0.1",
  noCompression: true,
  outDir,
  port: 0,
});

process.stdout.write(`VINEXT_TEST_PORT=${port}\n`);

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
