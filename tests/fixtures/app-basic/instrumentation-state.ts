/**
 * Shared in-memory state for instrumentation.ts testing.
 */

 export type CapturedRequestError = {
   message: string;
   path: string;
   method: string;
   routerKind: string;
   routePath: string;
   routeType: string;
 }

 /** Set to true when instrumentation.ts register() is called. */
 let registerCalled = false;

 /** List of errors captured by onRequestError(). */
 const capturedErrors: CapturedRequestError[] = [];

 export function isRegisterCalled(): boolean {
   return registerCalled;
 }

 export function getCapturedErrors(): CapturedRequestError[] {
   return [...capturedErrors];
 }

 export function markRegisterCalled(): void {
   registerCalled = true;
 }

 export function recordRequestError(entry: CapturedRequestError): void {
   capturedErrors.push(entry);
 }

 export function resetInstrumentationState(): void {
   registerCalled = false;
   capturedErrors.length = 0;
 }
