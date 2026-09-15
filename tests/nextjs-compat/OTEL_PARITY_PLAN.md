# OpenTelemetry and Tracing Parity Plan

Status: Draft for review

Last audited: 2026-09-14

Reference revisions:

- vinext live `main`: `9d45b5b92cf317abad69729088a1ded837620aad`
- Next.js canary: `b421cadefd31c1b59d117842021ded7c1ebaf5b4`
- Sentry fixture SDK: `@sentry/nextjs@10.62.0`

## Audited platform facts

- Next.js declares `@opentelemetry/api` as an optional peer, prefers the application's copy when present, and packages a private compiled fallback for its server tracer. Vinext preserves provider compatibility without a dependency by consuming the versioned global registry populated by standard provider registration; it cannot retain a runtime `require` that Worker bundlers resolve as a hard dependency.
- Workers custom spans created with [`tracing.enterSpan()`](https://developers.cloudflare.com/workers/observability/traces/custom-spans/) automatically inherit the active Workers span. Nested custom spans plus runtime-created fetch, KV, D1, and other binding spans share that hierarchy.
- Custom span attributes and logs appear in Workers traces and their OpenTelemetry exports.
- [Workers OpenTelemetry destinations](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/) can export the resulting native trace directly to any supported OTLP endpoint, including [Sentry](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/sentry/).
- Workers tracing does not yet automatically propagate W3C trace context to services outside Cloudflare. That limits cross-service correlation, but it does not prevent vinext built-ins and application/runtime spans from sharing the same trace inside one Worker invocation.

## Goal

Give vinext applications the stable, user-visible OpenTelemetry behavior documented by Next.js while using the existing real Sentry-on-Workers fixtures as one end-to-end consumer and Workers Observability as another.

Vinext must implement framework tracing, not a Sentry integration. Each logical framework span is defined and emitted from one shared call site. A registered OpenTelemetry provider, including Sentry's, and Cloudflare Workers tracing must both be able to consume those same built-in spans without backend-specific copies of the request lifecycle instrumentation.

## Public compatibility contract

The application-facing API must be identical to Next.js. Vinext must not add a `vinext` tracer export, provider option, Sentry adapter, or alternative instrumentation file.

An existing traced Next.js application must continue to use, unchanged:

- `instrumentation.ts` / `instrumentation.js` with `register()` and `onRequestError`;
- its existing `@opentelemetry/api` provider/SDK registration, when it owns one;
- ordinary integrations such as `@sentry/nextjs` and `Sentry.captureRequestError`;
- `experimental.clientTraceMetadata`;
- `NEXT_OTEL_VERBOSE` and `NEXT_OTEL_FETCH_DISABLED`;
- the documented Next.js span names and `next.*` attributes.

Installing vinext alone must not install or require OpenTelemetry packages. Applications that already bring an OTel API through their chosen SDK continue to use it; applications without an SDK still run normally and can use Workers tracing when deployed there.

## Proposed v1 contract

Vinext v1 tracing parity should include:

- one framework tracing layer and one set of logical span definitions across runtimes;
- incoming trace-context propagation;
- a request root span with Next.js-compatible names and attributes;
- the stable, documented Next.js framework spans;
- user spans correctly parented beneath the request span;
- error events correlated with their request trace;
- App Router and Pages Router behavior across Workers, Node production, and development;
- the same built-in framework spans in the active Workers handler/custom/binding trace;
- server-to-browser continuation through `experimental.clientTraceMetadata`.

The following are not required for v1:

- every internal span enabled by `NEXT_OTEL_VERBOSE=1`;
- Next.js build and compiler traces;
- Next.js experimental Request Insights/local span recording;
- inventing shared trace or span IDs between a user-installed OpenTelemetry SDK and the Workers runtime;
- external W3C trace-context propagation by Workers tracing before the platform supports it.

## Design constraints

1. Build a generic vinext framework tracer. Do not import or special-case Sentry in the runtime.
2. Define each logical span once. App/Pages request code must call one framework helper; it must not contain separate OpenTelemetry and Workers instrumentation branches.
3. Provide two integrations behind that helper:
   - the application's compatible `@opentelemetry/api`, sharing the provider registered by application instrumentation through OpenTelemetry's versioned global registry;
   - `cloudflare:workers` tracing, joining the runtime's active handler or application custom span and therefore its automatic fetch and binding spans.
4. When both integrations are active, one helper call enters both active contexts around the same callback. This intentionally produces equivalent framework spans in both configured outputs without duplicating framework call sites or business logic.
5. Preserve exact stable Next.js span names and `next.*` attributes where they are externally observable. Isolate capability differences in the integration: for example, OpenTelemetry can update a span name/status while the current Workers `Span` exposes attributes, exception recording, and completion but cannot rename a span.
6. Start with the smallest tracer needed for the stable spans. Do not port Next.js's complete internal tracer or local recorder.
7. Keep the OpenTelemetry side a cheap no-op when no provider is registered. Workers `enterSpan()` already runs as a non-recording no-op when the invocation is not sampled or tracing is disabled.
8. Trace each logical request once per active integration. Multi-stage Workers and internal request handoffs must not produce duplicate framework roots.
9. Instrumentation registration must complete before request spans are created and before packages requiring loader-based auto-instrumentation are evaluated.
10. Static prerender output must never retain request-specific propagation metadata or trace IDs.
11. Do not make shared trace IDs across the two integrations a prerequisite. Workers supplies native async parentage inside its trace; the registered OpenTelemetry provider supplies OTel context and propagation inside its output. The shared invariant is the framework span definition and call site, not synthetic identity stitching.
12. `@opentelemetry/api` must not be a vinext dependency. Consume the compatible provider, context manager, and propagator registered by the application through OpenTelemetry's versioned global registry. Standard provider registration necessarily populates that registry; a separate CommonJS lookup adds no provider-sharing capability and makes Worker bundlers treat the optional package as required.

## Backlog

### OTel-1: Extend the Sentry E2E harness to consume framework traces

This should be a harness-only PR and the first change in the stack.

Work:

- Change both Cloudflare Sentry fixtures from `tracesSampleRate: 0` to sampled tracing.
- Extend both `sentry-test-state.ts` implementations to parse Sentry transaction envelopes and child spans alongside error events.
- Record transaction name, trace ID, span ID, parent span ID, operation, status, transaction source, and relevant `next.*` attributes.
- Drop transactions for the envelope receiver and test-state endpoints with `beforeSendTransaction` or an equivalent public SDK option. This prevents the loopback DSN from recursively tracing and reporting its own envelope requests.
- Add a fixture endpoint that creates an application span through the application's existing public tracing integration while handling a traced request.
- Prove that `@sentry/nextjs` emits sampled transaction and child-span envelopes under Workerd. The actual global `@opentelemetry/api` provider handshake is exercised in OTel-2 when vinext first emits a framework span.
- Do not add `@opentelemetry/api` as a direct dependency of the Sentry fixtures merely to make vinext work. The unchanged `@sentry/nextjs` setup must be sufficient for vinext's built-in spans to reach Sentry.
- Treat Sentry only as the assertion sink for the standard OpenTelemetry integration. No Sentry type, envelope shape, or SDK behavior may enter the vinext framework tracer.
- Preserve all existing server-error and browser-error assertions.
- Link every ported assertion to the relevant Next.js OpenTelemetry E2E source.

Acceptance criteria:

- App Router and Pages Router fixtures each emit a captured transaction.
- The transaction contains an application-created child span made through the fixture's existing public SDK/API.
- Apart from enabling sampling and adding assertions, the fixtures retain the integration shape an ordinary Next.js application uses: `Sentry.init(...)`, `register()`, and `onRequestError = Sentry.captureRequestError`.
- The loopback collector does not generate recursive envelope traffic.
- Existing Sentry error tests remain green.
- The harness asserts stable fields only; it does not snapshot timing, generated IDs, or child-span array order.

### OTel-2: Add the shared framework tracer and its OTel/Workers integrations

Work:

- Add a small typed server tracing helper that owns the logical span descriptor and supports:
  - running synchronous or asynchronous work in an active span;
  - correct span completion for returned promises;
  - exception recording and error status;
  - incoming propagation extraction;
  - updating the active request span with route and response information.
- Add an OpenTelemetry integration that preserves Next.js's provider-sharing behavior without adding a vinext dependency:
  - prefer the compatible provider, context manager, and propagator installed by application instrumentation in OpenTelemetry's versioned global registry;
  - do not add `@opentelemetry/api` to vinext's dependencies, peers, or build inputs;
  - keep a bare installation a synchronous no-op with no missing-module error.
- Add a Workers integration using `tracing` from `cloudflare:workers`. Select it through build/runtime environment wiring that does not make Node evaluate a Workers-only module and does not make synchronous tracing APIs asynchronous.
- Compose enabled integrations at the framework helper boundary. The application callback must execute once while both integrations' spans are active, so nested framework calls, user spans, fetches, and bindings inherit the appropriate active parent.
- Keep backend capability mapping private:
  - apply common names, attributes, and completion to both, including `error.type` for failures;
  - record exceptions on both integrations where the runtime exposes that capability;
  - use OTel span status and name updates where supported;
  - represent final name/status on Workers with the same stable attributes rather than inventing unsupported APIs.
- Use the Next.js tracer identity and stable attributes:
  - `next.span_category`;
  - `next.span_name`;
  - `next.span_type`;
  - `next.route`;
  - `next.rsc`.
- Measure the packed-package size and Worker bundle delta of the framework tracer and Workers integration.

Acceptance criteria:

- Focused unit tests cover synchronous success, asynchronous success, rejection, exception recording, nesting, no-provider/non-sampled behavior, and concurrent isolation.
- Contract tests feed one logical span descriptor to fake OTel and Workers integrations and assert identical stable names/attributes, one callback execution, and correct nesting order.
- A Worker build resolves the native integration; a Node build does not import or evaluate `cloudflare:workers`.
- An extracted packed vinext installation with no `node_modules` and no OTel SDK starts without a missing-module error and uses the no-op path.
- A generic fixture with an application-owned OTel provider receives vinext spans without importing a vinext-specific API.
- The existing Sentry fixtures receive vinext spans with their ordinary Next.js configuration and without adding a direct OTel dependency or vinext-specific setup.
- The Sentry fixture proof demonstrates that vinext's `@opentelemetry/api` span is observed by the provider installed by `@sentry/nextjs` under Workerd; using `Sentry.startSpan()` alone is not sufficient for this acceptance criterion.
- The helper contains no Sentry imports or Sentry-specific attribute handling.
- No runtime request call sites are changed in this PR.

### OTel-3: Add the request root span and incoming propagation

This is the highest-value functional PR.

Work:

- Complete instrumentation registration before starting the request root span.
- Extract context from request headers using the propagator registered with `@opentelemetry/api`; let the Workers integration inherit the active runtime handler/application span.
- Create one logical `BaseServer.handleRequest` server span through the shared framework tracer.
- Initially attach method and target, then update it after route resolution with:
  - the parameterized route;
  - `http.route`;
  - `next.route`;
  - `next.rsc`;
  - response status;
  - error status and `error.type` for failures.
- Rename the final span to the Next.js form, such as `GET /blog/[slug]` or `RSC GET /blog/[slug]`.
- Ensure the root scope covers response finalization and runs inside vinext's Worker `ExecutionContext` scope so Sentry can flush through `waitUntil`.
- Apply the same helper at the correct outer boundary for:
  - App Router Workers;
  - Pages Router Workers;
  - Node production;
  - App Router development;
  - Pages Router development.
- Prevent duplicate roots across multi-stage Workers, internal prerender probes, and authenticated internal handoffs.
- Do not add separate native tracing calls to any of those request paths; the shared helper must emit the Workers representation automatically.

Sentry E2E acceptance criteria:

- Dynamic App and Pages routes produce `GET /trace/[slug]`, not a concrete high-cardinality pathname.
- A user-created span is a child of the request transaction.
- A supplied `sentry-trace` header is respected by the Sentry propagator.
- Generic unit coverage separately verifies W3C `traceparent` extraction.
- Parallel requests receive distinct trace IDs and do not leak active context.
- A 500 response marks the request transaction as failed.

Workers integration acceptance criteria:

- The same focused Worker request contains `BaseServer.handleRequest` beneath the runtime handler or an application-owned native custom span.
- The Workers span carries the same stable `next.*`, route, response, and error attributes asserted by the Sentry E2E, within the current native API's supported value types.

### OTel-4: Correct `onRequestError` parity and trace correlation

Work:

- Update the vinext error context to current Next.js semantics:
  - use `routeType: "proxy"` instead of `"middleware"`;
  - add `renderSource`;
  - provide `revalidateReason` consistently;
  - accept `unknown` errors at the public hook boundary.
- Report proxy/middleware failures through `onRequestError`.
- Ensure reporting occurs while the request span remains active.
- Preserve Worker `waitUntil` flushing and the existing Sentry request-context bridge.

Sentry E2E acceptance criteria:

- Existing render and route error events share the request transaction's trace ID.
- App and Pages proxy error cases report the current Next.js context shape.
- Assertions cover `routerKind`, `routePath`, `routeType`, `renderSource`, and `revalidateReason` where applicable.

### OTel-5: Add stable App Router framework spans

Add the stable App Router boundaries exposed by Next.js:

- `AppRender.getBodyResult`;
- `AppRender.fetch`;
- `AppRouteRouteHandlers.runHandler`;
- `ResolveMetadata.generateMetadata`;
- `NextNodeServer.getLayoutOrPageModule`;
- `NextNodeServer.startResponse`.

Requirements:

- Add each boundary once through the shared framework tracer so its OTel and Workers representations cannot drift.
- Honor `NEXT_OTEL_FETCH_DISABLED=1` so Sentry and other agents can disable vinext's framework fetch span and avoid double instrumentation.
- Record route information and errors consistently.
- Keep feature-specific tracing out of request paths that do not use the feature.
- Do not turn build-time prerender work into request-time transactions.

Sentry E2E acceptance criteria:

- An App Page render transaction contains the render span.
- A Route Handler transaction contains the route-handler span.
- A dynamic metadata page contains the metadata span.
- Child assertions use span type, name, attributes, and parent identity rather than timing or list position.

Workers acceptance criteria:

- The same App Page, Route Handler, and metadata span definitions appear beneath `BaseServer.handleRequest` in Workers Observability, with runtime-created fetch/binding spans parented to the active framework span that issued them.

### OTel-6: Add stable Pages Router framework spans

Add:

- `Render.getServerSideProps`;
- `Render.getStaticProps`;
- `Render.renderDocument`;
- `Node.runHandler` for API routes;
- `NextNodeServer.findPageComponents`.

Requirements:

- Add each boundary once through the shared framework tracer so its OTel and Workers representations cannot drift.
- Do not add `NextNodeServer.startResponse` to buffered Pages renders. Current Next.js sends those payloads with `res.end(payload)` and its authoritative Pages OTel expectations omit that span; only instrument a future Pages streaming path if Next.js exposes and tests the same boundary.

Sentry E2E acceptance criteria:

- A `getServerSideProps` request contains the GSSP and document-render spans.
- A Pages API request contains the API-handler span.
- ISR regeneration covers `getStaticProps` without treating build-time prerendering as a live request trace.
- App and Pages transactions use the same root naming and status rules.

Workers acceptance criteria:

- The same GSSP, document, API-handler, and page-component span definitions appear beneath `BaseServer.handleRequest` in Workers Observability when those paths execute there.

### OTel-7: Prove server-to-browser trace continuation

Work:

- Add a migration-style fixture whose existing `next.config.*` remains wrapped with `withSentryConfig(...)`; do not add `experimental.clientTraceMetadata` by hand as a vinext workaround.
- Prove both supported adoption paths:
  - `vinext init`, where the existing Next.js dependency/config remains while vinext is evaluated alongside it;
  - a completed switch where `next` has been removed and vinext is the framework package.
- Audit Sentry's build-time `next/package.json` version lookup. If removing `next` prevents the unchanged wrapper from adding `experimental.clientTraceMetadata`, provide a general Next package identity/version compatibility seam or coordinate the upstream integration contract. Do not special-case Sentry inside the framework tracer and do not require the application to patch its config.
- Render the metadata from the real active request span.
- Ensure cached HTML never replays another request's propagation metadata.
- Preserve the initial document's metadata during client navigation.

Sentry E2E acceptance criteria:

- A dynamic page's server transaction and browser pageload transaction share a trace.
- The unchanged `withSentryConfig(...)` fixture enables the required client trace metadata without a vinext-specific option or manual metadata addition.
- Two hard loads receive distinct server span IDs.
- Static production HTML contains no build-time trace metadata.
- Client navigation does not replace the initial document's trace metadata.
- Existing browser error reporting remains green.

### OTel-8: Fix production instrumentation loading

Work:

- Rebase the useful parts of [vinext PR #2854](https://github.com/cloudflare/vinext/pull/2854) onto current `main` without retaining its unrelated stacked dependency.
- Preserve direct `@opentelemetry/*`, `import-in-the-middle`, and `require-in-the-middle` package identities where loader hooks require physical package boundaries.
- Finish [vinext issue #2515](https://github.com/cloudflare/vinext/issues/2515): instrumentation must initialize before statically imported instrumented packages are evaluated.
- Do not require users to add a manual `NODE_OPTIONS=--import` workaround.

Acceptance criteria:

- A production Node build proves that a real ESM package is intercepted by OpenTelemetry instrumentation.
- The same test fails if the instrumented package or hook registry is bundled incorrectly.
- Worker builds remain self-contained and select Sentry's `workerd`/`worker` export.
- Node and Worker Sentry initialization remain independently covered.
- A copied existing Next.js/Sentry configuration works after switching the command/package to vinext, with no vinext-specific tracing setup and no newly required OTel package.

### OTel-9: Repair and prove Cache Components tracing

Work:

- Replace the `globalThis.require`-only OpenTelemetry lookup in `server/otel-tracer-extension.ts` with the OpenTelemetry integration used by the shared framework tracer. This extension still patches the application's OTel tracer behavior; it must not create a parallel framework tracing path.
- Port Next.js's exact `cache-components-allow-otel-spans` fallback-resume test.
- Verify fresh span IDs on each request and correct work-unit context inside span callbacks.

This remains blocked until vinext's deferred Cache Components fallback-resume path is supported. It should not block request tracing or the other stable v1 spans.

### OTel-10: Document the support boundary

Work:

- Document one Next-compatible vinext framework tracing feature, including the stable built-in span set and attributes.
- Explain its supported outputs:
  - a provider registered through `@opentelemetry/api`, including Sentry;
  - Workers Observability and configured OTLP destinations through the native Workers tracing integration.
- Document that ordinary Next.js OTel/Sentry configuration is supported unchanged; do not document manual `clientTraceMetadata` as a vinext migration requirement.
- State that OTel packages are application-owned optional integrations, not required vinext dependencies, and that no vinext-specific tracing API exists.
- Document Workers tracing configuration, including that native custom spans and automatic fetch/binding spans share the trace with vinext's built-ins.
- Do not silently enable recording or export in generated projects. Sampling, retention, and destinations should remain deliberate deployment configuration.

Acceptance criteria:

- Documentation does not imply that `otel-tracer-extension.ts` creates framework spans.
- Documentation does not present Sentry tracing and Workers tracing as separate vinext implementations.
- Examples show the same vinext span names/attributes in a registered OTel provider and in a Workers trace, while clearly documenting platform-specific propagation limitations.
- The compatibility table is updated only after its corresponding E2E evidence is green.

### OTel-11: Prove Workers custom, binding, and vinext built-in spans share the tracing architecture

This is the final application/platform validation track after OTel-3, OTel-5, and OTel-6. It should require no additional changes inside the `vinext` package: the Workers integration was added to the shared tracer in OTel-2, and every later built-in span used it automatically.

`apps/web/wrangler.jsonc` already enables Workers traces. Use `apps/web` as the live proof because it has a custom Worker entry, real D1/R2/KV bindings, and a scheduled maintenance handler.

Recommended work:

- Import `tracing` from `cloudflare:workers` in `apps/web/worker/index.ts`.
- Refresh `apps/web`'s generated/authoritative Workers types to a version that includes the public tracing API. The currently resolved `@cloudflare/workers-types@4.20260313.1` predates it; do not add a handwritten `cloudflare:workers` tracing declaration.
- Wrap delegation to `handler.fetch(...)` in a durable application-owned span such as `vinext.web.request`. This proves an outer Workers custom span can contain vinext's request root and all applicable built-in children without any special integration code in the application.
- Add or select a stable App Page/Route Handler path that exercises built-in spans from OTel-3 and OTel-5, plus at least one fetch or binding operation inside a framework span.
- Add a native custom span inside application route code as well. This proves application spans created below a vinext framework span inherit that framework span as their native parent.
- Wrap the existing scheduled performance-profile sweep in a named native custom span such as `vinext.web.sweepPerformanceProfiles`.
- Add low-cardinality attributes such as the number of candidate objects and successfully deleted objects. Do not attach object keys or other unbounded identifiers.
- Keep the existing `ctx.waitUntil(...)` lifecycle so the scheduled work and span finish before the invocation is retired.
- Let D1 and R2 calls execute inside the custom-span callback so Workers' automatic binding spans become its children.
- Add a focused unit test only for ordinary application behavior; do not mock Cloudflare's tracing implementation as proof that the runtime records a span.
- Do not add a production Sentry SDK dependency to `apps/web` for this proof. Workers traces, including custom and vinext built-in spans, are already OpenTelemetry-exportable through a configured Workers Observability destination.

Live acceptance criteria:

- Deploy an exact `apps/web` revision to a pr alias with tracing enabled.
- Observe one request trace in Workers Observability with a single hierarchy containing:
  - the Workers handler root;
  - the application-owned outer `vinext.web.request` span;
  - vinext's `BaseServer.handleRequest` span with the parameterized route and final status attributes;
  - the applicable built-in children added in OTel-5, such as `AppRender.getBodyResult` or `AppRouteRouteHandlers.runHandler`;
  - the application-owned inner custom span;
  - automatic fetch or binding spans beneath the framework/application span that initiated them.
- Observe a scheduled invocation in Workers Observability containing:
  - the scheduled-handler root span;
  - `vinext.web.sweepPerformanceProfiles` as a child;
  - D1 and, when deletion work exists, R2 binding spans nested below it;
  - the custom low-cardinality attributes.
- Record the deployed version ID, invocation time, and a screenshot or exported trace reference in the PR.
- Confirm that ordinary vinext requests and the Sentry/OTel E2Es remain unaffected.

Cross-consumer parity acceptance criteria:

- Compare the Workers trace with the Sentry E2E for the equivalent route and assert the same vinext span types, names, and stable attributes. These assertions must originate from shared test constants or descriptor contract tests where practical, rather than two handwritten lists that can drift.
- If a review environment can configure a Workers OTLP destination, export the exact Workers trace to a temporary or existing Sentry project and verify the handler, application custom, vinext built-in, fetch, and binding spans arrive as one exported trace. This is live evidence, not a required local CI dependency.
- Retain the ordinary Sentry fixture proof that an application-created `@opentelemetry/api` span parents correctly within vinext's OTel representation. This verifies standard Next.js ecosystem compatibility independently of the Workers-native application span proof.
- Do not require the in-process Sentry SDK representation and the Workers runtime representation to share generated IDs. They are two consumers of the same logical framework instrumentation; Workers' own built-in, application custom, fetch/binding, and vinext spans must share one native trace.
- Remove any test-only endpoint before merge if it has no lasting operational value.

### OTel-12: Close the audited v1 parity gaps

The cumulative stack audit found eight remaining gaps that fit the v1 contract:

1. Await App Route Handler `onRequestError` hooks before completing foreground failures and inside
   background-regeneration promises. Keep App Page and Server Action React `onError` callbacks
   non-blocking, matching Next.js; Workers retain their reporting promises through `waitUntil`.
2. Await Pages Router `onRequestError` hooks before completing page and pre-commit API failures in
   both Node and Workers. Keep API errors after the response commits non-blocking, matching Node's
   response lifecycle, while retaining their reporting promises through Workers `waitUntil`.
3. Propagate Pages-development instrumentation import and `register()` failures instead of serving
   requests without instrumentation.
4. Preserve Next.js's handled App-500 request-root semantics: `error.type` remains `"500"`, and the
   application exception message is not used as the root span status description.
5. Add the stable App Router `NextNodeServer.findPageComponents` span directly beneath the request
   root for App Pages and Route Handlers.
6. Establish Cache Component work-unit context for ordinary request/cache scopes and port the
   unblocked `/novel/cache` and `/novel/server` cases from Next.js.
7. Match Next.js's runtime-specific `Node.runHandler` error status for throwing Pages API handlers:
   successful in Node production, errored in development and Edge/Workers.
8. Make `experimental.clientTraceMetadata` inject only the active OpenTelemetry context; do not
   create a disconnected synthetic span when no span is active.

Every layer must keep `@opentelemetry/api` optional, exercise the shared framework descriptors
rather than add consumer-specific tracing, and add Sentry E2E coverage when the behavior is
observable through the existing fixtures. Node/Workers differences must be asserted explicitly.

Deliver the closure in three focused PRs:

1. Instrumentation lifecycle: gaps 1-3.
2. Span shape and status: gaps 4, 5, and 7.
3. OpenTelemetry context edges: gaps 6 and 8. Split the Cache Components work into a fourth PR only
   if establishing its ordinary work-unit scope would make this layer materially harder to review.

The following audit findings remain outside this closure track:

- `Instrumentation.loadModule` and `Instrumentation.register` are verbose/internal lifecycle spans,
  not part of the v1 stable span contract.
- The Cache Components fallback-resume case remains blocked on vinext's request-time deferred
  fallback-shell resume path. OTel-12 ports only the ordinary cache cases that the current runtime
  can execute; it must not grow into that separate rendering feature.

## Recommended delivery order

1. OTel-1: Sentry trace harness
2. OTel-2: shared framework tracer with OTel and Workers integrations
3. OTel-3: request root and propagation
4. OTel-4: error/proxy context and correlation
5. OTel-5 and OTel-6: stable App and Pages spans
6. OTel-7: browser continuation
7. OTel-11: deployed shared-trace proof for Workers custom, binding, and vinext built-in spans
8. OTel-10: final support documentation
9. OTel-12: focused parity-closure layers in the order listed above

OTel-8 can proceed independently after OTel-1. OTel-9 waits for the Cache Components runtime path. OTel-11 waits for the request root and stable framework spans; its code changes should remain confined to application fixtures or `apps/web` because the shared Workers integration already landed in OTel-2.

## Definition of done for v1 tracing parity

For both App Router and Pages Router, the real Sentry E2Es must prove:

1. a dynamic 200 response emits a parameterized request transaction;
2. a user OpenTelemetry span is a child of that request transaction;
3. stable framework child spans are present with Next.js-compatible types and attributes;
4. incoming propagation context is honored;
5. a 500 error event is correlated with the request trace;
6. parallel requests remain isolated;
7. server-to-browser trace metadata continues a dynamic request trace without leaking through cached HTML.

Node production must additionally prove that loader-based package instrumentation initializes early enough and retains the required package identities.

Workers must additionally prove that the same built-in span definitions appear in the active Workers trace together with application custom spans and automatic fetch/binding spans. OTel-11 supplies this live evidence; it is not a separate vinext tracing system.

At least one migration-style fixture must prove that an existing Next.js/Sentry setup works unchanged under vinext, other than the normal framework command/package substitution.

## Review decisions

Before implementation, confirm:

1. Stable documented Next.js spans are v1; verbose internal spans are post-v1.
2. Node production parity is part of v1 rather than a Workers-only follow-up.
3. The shared framework tracer supports both a registered OpenTelemetry provider and Workers tracing; framework call sites and span descriptors are never duplicated per consumer.
4. When both integrations are available in a Worker, the shared helper emits the logical framework span to both so either consumer can observe it.
5. `@opentelemetry/api` is not a vinext dependency. Vinext joins the application's compatible provider through OpenTelemetry's versioned global registry.
6. Vinext exposes no new tracing configuration or runtime API; existing Next.js OTel and Sentry integrations are the public compatibility contract.
