import { beforeEach, describe, expect, it } from "vitest";
import {
  getReportedSentryErrors,
  getReportedSentryTransactions,
  recordSentryEnvelope,
  resetSentryReports,
} from "./fixtures/sentry-test-state";

describe("Sentry fixture envelope state", () => {
  beforeEach(resetSentryReports);

  it("records transaction roots and child spans without adding an empty error", () => {
    recordSentryEnvelope(
      "1",
      [
        JSON.stringify({ event_id: "event" }),
        JSON.stringify({ type: "transaction" }),
        JSON.stringify({
          type: "transaction",
          transaction: "fixture.transaction",
          transaction_info: { source: "custom" },
          contexts: {
            trace: {
              data: { "fixture.router": "app" },
              op: "fixture.request",
              span_id: "1111111111111111",
              status: "ok",
              trace_id: "22222222222222222222222222222222",
            },
          },
          spans: [
            {
              data: { "fixture.child": true },
              description: "fixture.child",
              op: "fixture.child",
              parent_span_id: "1111111111111111",
              span_id: "3333333333333333",
              status: "ok",
              trace_id: "22222222222222222222222222222222",
            },
          ],
        }),
      ].join("\n"),
    );

    expect(getReportedSentryErrors()).toEqual([]);
    expect(getReportedSentryTransactions()).toEqual([
      {
        name: "fixture.transaction",
        projectId: "1",
        traceId: "22222222222222222222222222222222",
        spanId: "1111111111111111",
        operation: "fixture.request",
        status: "ok",
        source: "custom",
        attributes: { "fixture.router": "app" },
        spans: [
          {
            name: "fixture.child",
            traceId: "22222222222222222222222222222222",
            spanId: "3333333333333333",
            parentSpanId: "1111111111111111",
            operation: "fixture.child",
            status: "ok",
            attributes: { "fixture.child": true },
          },
        ],
      },
    ]);
  });

  it("preserves existing error envelope parsing", () => {
    recordSentryEnvelope(
      "1",
      [
        JSON.stringify({ event_id: "event" }),
        JSON.stringify({ type: "event" }),
        JSON.stringify({
          exception: { values: [{ value: "fixture error" }] },
          contexts: {
            nextjs: {
              request_path: "/error",
              router_kind: "App Router",
              router_path: "/error",
              route_type: "render",
            },
            trace: {
              span_id: "1111111111111111",
              trace_id: "22222222222222222222222222222222",
            },
          },
          sdk: { name: "sentry.javascript.nextjs" },
        }),
      ].join("\n"),
    );

    expect(getReportedSentryErrors()).toEqual([
      {
        message: "fixture error",
        projectId: "1",
        requestPath: "/error",
        routerKind: "App Router",
        routerPath: "/error",
        routeType: "render",
        sdkName: "sentry.javascript.nextjs",
        spanId: "1111111111111111",
        traceId: "22222222222222222222222222222222",
      },
    ]);
    expect(getReportedSentryTransactions()).toEqual([]);
  });
});
