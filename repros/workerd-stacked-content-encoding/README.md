# Workerd stacked `Content-Encoding` reproduction

Minimal framework-free reproduction of Workerd failing to automatically decode an HTTP response
whose `Content-Encoding` contains more than one coding.

The local origin serves the same JSON in two forms:

- `/single`: compressed once, with `Content-Encoding: gzip`
- `/stacked`: compressed twice, with two `Content-Encoding: gzip` header fields (exposed by
  `Headers` as the equivalent list value `gzip, gzip`)

## Run

Requires Node.js 22+.

Terminal 1:

```sh
node origin.mjs
```

Terminal 2:

```sh
npx wrangler@4.124.0 dev --port 8787
```

Terminal 3:

```sh
curl -s http://127.0.0.1:8787 | jq
node node-baseline.mjs
```

No deployment, account, bindings, or application framework are involved.

## Expected

Default Fetch behavior should decode every advertised content coding in reverse application order:

- `singleDefault.json` is `{ "ok": true }`.
- `stackedDefault.json` is `{ "ok": true }` after two gzip decoding steps.
- `stackedManual` begins with gzip magic bytes (`1f8b`) and fails JSON parsing because
  `encodeResponseBody: "manual"` explicitly requests the encoded representation.

Node's native Fetch is included as the behavioral baseline. It decodes both `/single` and
`/stacked` successfully while retaining the original `Content-Encoding` header value.

## Actual Workerd behavior

The single-coding control succeeds, but the stacked default request behaves like manual mode:

```text
singleDefault:  contentEncoding="gzip",       json={"ok":true}
stackedDefault: contentEncoding="gzip, gzip", firstBytesHex starts "1f8b", jsonError is set
stackedManual:  contentEncoding="gzip, gzip", firstBytesHex starts "1f8b", jsonError is set
```

Confirmed locally with Wrangler 4.124.0 on 2026-08-18. The stacked response was 48 bytes in both
default and manual mode, beginning with `1f8b080000000000`; the single response decoded to the
12-byte JSON payload. Running `node node-baseline.mjs` decoded both responses successfully.

The raw `/stacked` body is genuinely gzip-compressed twice; removing the duplicate header value
without changing the body would be incorrect.

## Suspected implementation gap

At the time of this handoff, Workerd's `getContentEncoding()` compares the complete header value
only against exact `gzip` or `br` strings and otherwise returns `IDENTITY`:

<https://github.com/cloudflare/workerd/blob/main/src/workerd/api/system-streams.c%2B%2B#L413-L428>

HTTP defines `Content-Encoding` as a list and explicitly permits a coding to be applied more than
once. See RFC 9110 section 8.4:

<https://www.rfc-editor.org/rfc/rfc9110#section-8.4>

The likely runtime fix is to parse the full content-coding list and construct the decoding chain in
reverse order. Header retention is intentionally left out of scope; this reproduction only checks
whether the response body is decoded.
