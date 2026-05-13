/**
 * Narrow an `unknown` caught value (per TypeScript 4.4+ default catch type)
 * into a printable string. Replaces the legacy `catch (err: any)
 * { ... err.message ... }` shape that violates `no-unsafe-member-access`.
 *
 * Usage:
 *   } catch (err) {
 *     console.error(`failed: ${errorMessage(err)}`);
 *   }
 *
 * Why a helper instead of inlining `err instanceof Error ? err.message : String(err)`?
 *  - 35+ catch sites in src/ before this refactor; one helper kills the
 *    repetition.
 *  - The string-form `String(err)` produces `"[object Object]"` for plain
 *    objects, which is unhelpful; this helper falls back to `JSON.stringify`
 *    for those before degrading further. Empty / nullish errors get a
 *    fixed sentinel so the call site never logs a bare empty string.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === undefined || err === null) return "unknown error";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    try {
      return JSON.stringify(err);
    } catch {
      return Object.prototype.toString.call(err);
    }
  }
  // After all the narrowing branches above, err must be a primitive
  // (number, boolean, bigint, symbol, function) — String() is safe.
  // eslint-disable-next-line @typescript-eslint/no-base-to-string
  return String(err);
}

/**
 * Same shape as {@link errorMessage} but returns the unwrapped `Error`
 * when one is present, otherwise wraps the original value. Useful for
 * `throw new Error(..., { cause })` rethrows where the cause field
 * needs an Error instance.
 */
export function asError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(errorMessage(err));
}

/**
 * Type guard for Node.js errno errors (ENOENT, EEXIST, EACCES, …).
 * Replaces the `catch (err: any) { if (err.code === "ENOENT") }` shape
 * — under strict ESLint the bare `err.code` access is an unsafe-member.
 *
 * Usage:
 *   } catch (err) {
 *     if (isErrno(err) && err.code === "ENOENT") return null;
 *     throw err;
 *   }
 */
export function isErrno(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
