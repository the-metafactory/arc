import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestEnv, type TestEnv } from "../helpers/test-env.js";
import { mockFetch } from "../helpers/mock-fetch.js";
import {
  reviewList,
  reviewShow,
  reviewApprove,
  reviewReject,
  reviewRequestChanges,
  formatReviewList,
  formatReviewShow,
  formatReviewAction,
} from "../../src/commands/review.js";
import { saveSources } from "../../src/lib/sources.js";
import type { SourcesConfig } from "../../src/types.js";

let env: TestEnv;
let savedFetch: typeof fetch;

beforeEach(async () => {
  env = await createTestEnv();
  savedFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = savedFetch;
  await env.cleanup();
});

function mfSource(): SourcesConfig {
  return {
    sources: [{
      name: "mf-test",
      url: "https://meta-factory.test",
      tier: "official",
      enabled: true,
      type: "metafactory",
      token: "test-token",
    }],
  };
}

function mfSourceNoToken(): SourcesConfig {
  return {
    sources: [{
      name: "mf-test",
      url: "https://meta-factory.test",
      tier: "official",
      enabled: true,
      type: "metafactory",
    }],
  };
}

const submissionFixture = {
  id: "sub-1",
  package_version_id: "pv-1",
  submitted_by: "acc-submitter",
  sponsor_id: "acc-sponsor",
  status: "pending_review",
  validation_result: null,
  audit_result: null,
  capability_change: false,
  hold_until: null,
  review_comment: null,
  reviewed_at: null,
  created_at: 1_700_000_000,
  updated_at: 1_700_000_000,
};

// ── reviewList ────────────────────────────────────────────────

describe("arc review list", () => {
  test("fails without metafactory source", async () => {
    await saveSources(env.paths.sourcesPath, { sources: [] });
    const r = await reviewList({ paths: env.paths });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/metafactory/i);
  });

  test("fails without authentication", async () => {
    await saveSources(env.paths.sourcesPath, mfSourceNoToken());
    const r = await reviewList({ paths: env.paths });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/login/);
  });

  test("returns submissions from server", async () => {
    await saveSources(env.paths.sourcesPath, mfSource());
    mockFetch(async (url: any) => {
      expect(String(url)).toContain("/api/v1/review/pending");
      return new Response(
        JSON.stringify({ submissions: [submissionFixture], total: 1, page: 1, per_page: 20 }),
        { status: 200 },
      );
    });
    const r = await reviewList({ paths: env.paths });
    expect(r.success).toBe(true);
    expect(r.submissions?.length).toBe(1);
    expect(r.total).toBe(1);
  });

  test("surfaces server error message on 403", async () => {
    await saveSources(env.paths.sourcesPath, mfSource());
    mockFetch(async () =>
      new Response(JSON.stringify({ error: "Forbidden", message: "Not authorised" }), { status: 403 }),
    );
    const r = await reviewList({ paths: env.paths });
    expect(r.success).toBe(false);
    expect(r.error).toBe("Not authorised");
  });

  test("clamps --per-page client-side above 100", async () => {
    await saveSources(env.paths.sourcesPath, mfSource());
    let capturedUrl = "";
    mockFetch(async (url: any) => {
      capturedUrl = String(url);
      return new Response(
        JSON.stringify({ submissions: [], total: 0, page: 1, per_page: 100 }),
        { status: 200 },
      );
    });
    const r = await reviewList({ paths: env.paths, perPage: 500 });
    expect(r.success).toBe(true);
    expect(capturedUrl).toContain("per_page=100");
  });

  test("--json formatter emits raw JSON", () => {
    const out = formatReviewList({
      success: true,
      submissions: [submissionFixture],
      total: 1,
      page: 1,
      per_page: 20,
      json: true,
    });
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

// ── reviewShow ────────────────────────────────────────────────

describe("arc review show", () => {
  test("returns detail for a known id", async () => {
    await saveSources(env.paths.sourcesPath, mfSource());
    mockFetch(async (url: any) => {
      expect(String(url)).toContain("/api/v1/review/sub-1");
      return new Response(JSON.stringify({ submission: submissionFixture }), { status: 200 });
    });
    const r = await reviewShow({ paths: env.paths, id: "sub-1" });
    expect(r.success).toBe(true);
    expect(r.submission?.id).toBe("sub-1");
  });

  test("404 surfaces server error", async () => {
    await saveSources(env.paths.sourcesPath, mfSource());
    mockFetch(async () => new Response(JSON.stringify({ error: "Not found" }), { status: 404 }));
    const r = await reviewShow({ paths: env.paths, id: "nope" });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/Not found|HTTP 404/);
  });

  test("pretty-prints stringified validation_result", () => {
    const vr = JSON.stringify({ risk_level: "low", summary: "ok" });
    const out = formatReviewShow({
      success: true,
      submission: { ...submissionFixture, validation_result: vr },
    });
    expect(out).toContain("validation_result:");
    // Pretty-printed — each key on its own line with indentation
    expect(out).toContain(`"risk_level": "low"`);
    expect(out).toContain(`"summary": "ok"`);
  });
});

// ── action commands ──────────────────────────────────────────

describe("arc review approve", () => {
  test("posts to /approve and surfaces submission", async () => {
    await saveSources(env.paths.sourcesPath, mfSource());
    let posted = false;
    mockFetch(async (url: any, init: any) => {
      posted = true;
      expect(String(url)).toContain("/api/v1/review/sub-1/approve");
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({ submission: { ...submissionFixture, status: "approved" } }),
        { status: 200 },
      );
    });
    const r = await reviewApprove({ paths: env.paths, id: "sub-1" });
    expect(posted).toBe(true);
    expect(r.success).toBe(true);
    expect(r.submission?.status).toBe("approved");
  });

  test("DD-9 self-review 403 surfaces server message", async () => {
    await saveSources(env.paths.sourcesPath, mfSource());
    mockFetch(async () =>
      new Response(
        JSON.stringify({ error: "Forbidden", message: "Cannot review your own submission (DD-9)" }),
        { status: 403 },
      ),
    );
    const r = await reviewApprove({ paths: env.paths, id: "sub-1" });
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/DD-9/);
  });

  test("--json formatter emits action JSON on success", () => {
    const out = formatReviewAction({
      success: true,
      action: "approve",
      submission: { ...submissionFixture, status: "approved" },
      json: true,
    });
    const parsed = JSON.parse(out);
    expect(parsed.action).toBe("approve");
    expect(parsed.submission.status).toBe("approved");
  });
});

describe("arc review reject", () => {
  test("rejects without --reason client-side", async () => {
    await saveSources(env.paths.sourcesPath, mfSource());
    const r = await reviewReject({ paths: env.paths, id: "sub-1" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("--reason");
  });

  test("rejects with whitespace-only reason", async () => {
    await saveSources(env.paths.sourcesPath, mfSource());
    const r = await reviewReject({ paths: env.paths, id: "sub-1", reason: "   " });
    expect(r.success).toBe(false);
    expect(r.error).toContain("--reason");
  });

  test("sends trimmed reason in POST body", async () => {
    await saveSources(env.paths.sourcesPath, mfSource());
    let body = "";
    mockFetch(async (_url: any, init: any) => {
      body = init?.body ?? "";
      return new Response(
        JSON.stringify({ submission: { ...submissionFixture, status: "rejected" } }),
        { status: 200 },
      );
    });
    const r = await reviewReject({ paths: env.paths, id: "sub-1", reason: "  breaks convention  " });
    expect(r.success).toBe(true);
    expect(JSON.parse(body)).toEqual({ reason: "breaks convention" });
  });
});

describe("arc review request-changes", () => {
  test("rejects without --message", async () => {
    await saveSources(env.paths.sourcesPath, mfSource());
    const r = await reviewRequestChanges({ paths: env.paths, id: "sub-1" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("--message");
  });

  test("sends comment in POST body", async () => {
    await saveSources(env.paths.sourcesPath, mfSource());
    let body = "";
    mockFetch(async (url: any, init: any) => {
      expect(String(url)).toContain("/request-changes");
      body = init?.body ?? "";
      return new Response(
        JSON.stringify({ submission: { ...submissionFixture, status: "changes_requested" } }),
        { status: 200 },
      );
    });
    const r = await reviewRequestChanges({ paths: env.paths, id: "sub-1", comment: "tweak manifest" });
    expect(r.success).toBe(true);
    expect(JSON.parse(body)).toEqual({ comment: "tweak manifest" });
  });
});
