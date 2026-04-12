/**
 * Shared fetch mock helper for tests that intercept HTTP calls.
 * Replaces globalThis.fetch with a test handler.
 * Restore the original with the value returned by saveFetch().
 */

export function mockFetch(fn: (...args: any[]) => Promise<Response>): void {
  (globalThis as any).fetch = fn;
}
