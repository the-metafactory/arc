// @ts-check
import tseslint from "typescript-eslint";
import eslint from "@eslint/js";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ── Strict (error): type-safety bugs we genuinely want to gate on ──
      //
      // These rules catch real bugs (un-awaited promises, missing branches,
      // wrong + on non-numerics). Violations fail lint.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],

      // ── Demoted to warn (existing-code sweep deferred) ────────────
      //
      // Real concerns but high cost to fix in this PR. Surface in IDE +
      // lint output, don't gate. Tighten in subsequent focused PRs.
      "@typescript-eslint/restrict-plus-operands": "warn",
      "no-useless-escape": "warn",
      "no-useless-assignment": "warn",
      "no-control-regex": "warn",
      "@typescript-eslint/no-require-imports": "warn",
      // Mirrors myelin#127. `throw new Error(msg)` from a catch block
      // should pass `{ cause: err }` to preserve the underlying exception
      // chain for debuggability.
      "preserve-caught-error": "error",

      // ── Warn: stylistic / preference rules with high pre-existing
      //         violation counts. Surface in IDE + lint output, don't
      //         gate the build. Tightened in subsequent PRs after a
      //         dedicated cleanup pass per rule.
      //
      //   require-await ........ 94 → many `async` fns without await
      //                           (often for future-proofing the signature)
      //   no-unnecessary-condition .. 63 → existsSync()-then-act idioms
      //   await-thenable ....... 26 → Bun.write returns Promise but lint
      //                           cannot prove it from generics
      //   no-empty-function ..... 25 → catch blocks with `{}` (intentional swallow)
      //   no-non-null-assertion . 23 → `result.files!` after success-narrow
      //   prefer-nullish-coalescing  8 → idiomatic `||` for string defaults
      //   no-explicit-any ...... infra layers that bridge untyped surfaces
      //   no-unsafe-* .......... Bun.spawnSync / process / yaml-parsed
      //                           dynamic data flows through these
      // Production code has zero require-await sites — myelin#121's
      // pattern: turn off in tests (adapter mocks have async signatures
      // without I/O), promote to error elsewhere so new src violations
      // gate the build.
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/no-unnecessary-condition": "warn",
      // 100% test-file noise from bun-test's
      // `await expect(promise).rejects.toThrow(...)` matcher idiom.
      // The matcher chain returns void; the rule reads it as awaiting
      // a non-thenable. Off in tests (override below), error at src
      // so genuine "awaiting a sync value" bugs get caught. Mirrors
      // myelin#123.
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-empty-function": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/prefer-nullish-coalescing": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-base-to-string": "warn",
      // Number / boolean interpolation in template literals is
      // universally understood — `Found ${count} matches` reads
      // cleanly. The rule still fires on `unknown`, `never`, `any`,
      // and exotic objects — those carry real correctness signal.
      // Mirrors myelin#122.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
      "@typescript-eslint/return-await": "warn",
      "@typescript-eslint/no-unused-expressions": "warn",
      // Commander-style fluent chains pass method references as args
      // (`.option(handler)`); the rule mis-reads them as `this`-rebinding
      // hazards. Real binding issues still surface via test failures.
      // 100% test-file noise today (mock helpers like `mock(fs.readFile)`
      // pass bound methods to `mock()`; rule reads them as `this`-leaks).
      // Off in tests, error in src so future commander-handler patterns
      // are flagged for explicit `.bind(this)` or arrow-function wrap.
      "@typescript-eslint/unbound-method": "error",
      // Mirrors myelin#127. `.catch((err: unknown) => …)` is the safe
      // idiom; bare `(err)` defaults to implicit `any`. All 2 arc sites
      // were already _err stubs; just type-annotated.
      "@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
      // Same bun-test idiom as await-thenable. Off in tests (override
      // below), error at src so a real `.forEach(() => doThing())`
      // where doThing returns void still gets caught when callers
      // expect a return value.
      "@typescript-eslint/no-confusing-void-expression": "error",
    },
  },
  {
    // Test files: looser rules — tests intentionally exercise edge cases
    // (any-typed mocks, unsafe casts for failure injection).
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-deprecated": "off",
      // Mocks of async-shaped interfaces (fetch / readFile / spawn
      // wrappers, …) implement `() => Promise<T>` without I/O to
      // await. The `async` keyword satisfies the type signature; the
      // rule's "unnecessary" verdict in test code is pure noise.
      // Mirrors myelin#121's test-override approach. Production code
      // has zero require-await sites today; this override only affects
      // tests.
      "@typescript-eslint/require-await": "off",
      // Bun-test's `await expect(promise).rejects.toThrow(...)` idiom
      // returns void from the matcher chain. Both rules fire as false
      // positives on every assert of that shape across the suite.
      // Mirrors myelin#123.
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/await-thenable": "off",
      // Tests routinely defensive-check values that the production
      // types claim are non-nullable, because mocks structurally
      // typed against an interface may not honor the type's promise.
      // `expect(maybeX).toBeDefined()` and similar guards are
      // intentional in test code. Mirrors myelin#124.
      "@typescript-eslint/no-unnecessary-condition": "off",
      // Empty mock methods that satisfy an interface contract without
      // behavior (e.g., `close() {}` on a test transport) are routine
      // in tests. Production stubs (6 sites today) get inline disables
      // or per-file banners. Mirrors myelin#125.
      "@typescript-eslint/no-empty-function": "off",
      // Mock helpers pass bound class methods (`mock(fs.readFile)`,
      // `spyOn(obj, "method")`); the rule mis-reads them as `this`
      // hazards. Real `this`-binding bugs surface as test failures.
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    // Files outside the typed-project scope (scripts/, eslint.config.js,
    // etc.). The strict project-service rules need a tsconfig "include"
    // entry to type-check; ignoring is cleaner than expanding include
    // for one-off scripts.
    ignores: [
      "dist/",
      "node_modules/",
      "vendor/",
      "**/*.bak.ts",
      "eslint.config.js",
      "scripts/",
    ],
  },
);
