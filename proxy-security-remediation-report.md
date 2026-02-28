# Proxy Middleware Export Bypass Remediation Report

Date: 2026-02-28  
Scope: Pages Router production/worker middleware dispatch

## Executive Summary

Vinext claimed Next.js 16 `proxy.ts` support, but Pages Router production codegen only executed `default` or legacy `middleware` exports. If an app used a named `proxy` export (`export function proxy(...)`), middleware silently did not run in production.  

This is a real auth/authorization bypass risk for apps that depend on `proxy.ts` to protect routes.

## What `proxy.ts` Is

In Next.js 16, `proxy.ts` is the pre-routing gate that runs before route handlers/pages. Teams commonly use it for:

- auth checks (`redirect("/login")` when unauthenticated),
- tenant/role gating,
- request normalization or rewrites.

`proxy.ts` can be exported as either:

- default export, or
- named `proxy` export.

## What Was Wrong (Pre-Fix)

Generated Pages Router production entry used:

- `middlewareModule.default || middlewareModule.middleware`

It did **not** include `middlewareModule.proxy`.

If the app only exported named `proxy`, vinext treated middleware as missing and returned `{ continue: true }`.

## Concrete Exploit Path (Pre-Fix)

1. App protects `/dashboard` in `proxy.ts` with named export:
   - `export function proxy(req) { if (!session) return redirect("/login") }`
2. App is built/deployed with Pages Router production path (Node prod server or Cloudflare worker entry).
3. Attacker sends direct request to `/dashboard`.
4. Generated `runMiddleware()` fails to find a callable middleware function (because named `proxy` is ignored).
5. Middleware is skipped.
6. Protected route executes and returns data/page that should have been blocked.

No account takeover or supply-chain compromise is required for this path.

## Impact

- Authentication and authorization checks in `proxy.ts` can be bypassed.
- Private pages/API routes behind matcher rules can become publicly reachable.
- Affects production behavior specifically; this can evade detection if local/dev path behaves differently.

## Remediation Applied

### 1) Fix middleware function resolution in generated production entry

Updated generated Pages Router `runMiddleware` dispatch to include named proxy export:

- from: `middlewareModule.default || middlewareModule.middleware`
- to: `middlewareModule.default || middlewareModule.proxy || middlewareModule.middleware`

File:

- `packages/vinext/src/index.ts`

### 2) Clarify runtime messaging/docs alignment

Updated middleware runner messaging/comments to explicitly state named `proxy` is supported.

File:

- `packages/vinext/src/server/middleware.ts`

### 3) Add regression coverage

- Unit test validates named `proxy` execution in middleware runner.
- Pages production build test validates generated `runMiddleware` executes named `proxy`.
- Pages production build test validates resolver precedence (`default > proxy > middleware`).
- App router codegen assertion keeps named `proxy` dispatch present.

Files:

- `tests/shims.test.ts`
- `tests/pages-router.test.ts`
- `tests/app-router.test.ts`

## Security Posture After Fix

- Named `proxy` exports now execute in Pages Router production codegen.
- Cloudflare Pages Router worker path (which imports `runMiddleware` from generated server entry) inherits the same resolver logic.
- The concrete bypass is closed for new builds.
- Existing deployments must be rebuilt/redeployed to pick up regenerated server entry code.
