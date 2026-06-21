#!/bin/sh
set -eu

cd ../../..
vp run vinext#build
cd tests/fixtures/next-form-parity
node ../../../packages/vinext/dist/cli.js build
printf '%s\n' '{"type":"module"}' > dist/package.json
cp dist/server/index.mjs dist/server/index.js
cp dist/server/ssr/index.mjs dist/server/ssr/index.js
exec node ../../../packages/vinext/dist/cli.js start --port 4191
