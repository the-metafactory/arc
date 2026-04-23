import { loadSources, findMetafactorySource } from "../lib/sources.js";
import {
  listPending,
  getSubmission,
  approveSubmission,
  rejectSubmission,
  requestChanges,
  type PendingSubmission,
  type SubmissionDetail,
} from "../lib/review.js";
import type { PaiPaths } from "../types.js";

export interface ReviewListOptions {
  paths: PaiPaths;
  sourceName?: string;
  page?: number;
  perPage?: number;
  json?: boolean;
}

export interface ReviewListResult {
  success: boolean;
  submissions?: PendingSubmission[];
  total?: number;
  page?: number;
  per_page?: number;
  json?: boolean;
  error?: string;
}

async function resolveSource(
  paths: PaiPaths,
  sourceName?: string,
): Promise<{ source: import("../types.js").RegistrySource } | { error: string }> {
  const sourcesConfig = await loadSources(paths.sourcesPath);
  const sourceResult = findMetafactorySource(sourcesConfig, sourceName);
  if ("error" in sourceResult) return { error: sourceResult.error };
  const src = sourceResult.source;
  if (!src.token) return { error: 'Not authenticated. Run "arc login" first.' };
  return { source: src };
}

const MAX_PER_PAGE = 100;

export async function reviewList(opts: ReviewListOptions): Promise<ReviewListResult> {
  const resolved = await resolveSource(opts.paths, opts.sourceName);
  if ("error" in resolved) return { success: false, error: resolved.error };
  // Server clamps to 100 silently; cap client-side so callers see the capped
  // value in the output and aren't surprised by a partial page.
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, opts.perPage ?? 20));
  if (opts.perPage && opts.perPage > MAX_PER_PAGE) {
    console.warn(`Note: --per-page clamped to ${MAX_PER_PAGE} (server maximum).`);
  }
  const r = await listPending(resolved.source, opts.page ?? 1, perPage);
  if (!r.success) return { success: false, error: r.error };
  return {
    success: true,
    submissions: r.submissions,
    total: r.total,
    page: r.page,
    per_page: r.per_page,
    json: opts.json,
  };
}

export interface ReviewShowOptions {
  paths: PaiPaths;
  sourceName?: string;
  id: string;
  json?: boolean;
}

export interface ReviewShowResult {
  success: boolean;
  submission?: SubmissionDetail;
  json?: boolean;
  error?: string;
}

export async function reviewShow(opts: ReviewShowOptions): Promise<ReviewShowResult> {
  const resolved = await resolveSource(opts.paths, opts.sourceName);
  if ("error" in resolved) return { success: false, error: resolved.error };
  const r = await getSubmission(resolved.source, opts.id);
  if (!r.success) return { success: false, error: r.error };
  return { success: true, submission: r.submission, json: opts.json };
}

export interface ReviewActionOptions {
  paths: PaiPaths;
  sourceName?: string;
  id: string;
  reason?: string;
  comment?: string;
  json?: boolean;
}

export interface ReviewActionCommandResult {
  success: boolean;
  action: "approve" | "reject" | "request-changes";
  submission?: SubmissionDetail;
  error?: string;
  json?: boolean;
}

export async function reviewApprove(
  opts: ReviewActionOptions,
): Promise<ReviewActionCommandResult> {
  const resolved = await resolveSource(opts.paths, opts.sourceName);
  if ("error" in resolved) return { success: false, action: "approve", error: resolved.error, json: opts.json };
  const r = await approveSubmission(resolved.source, opts.id);
  return { success: r.success, action: "approve", submission: r.submission, error: r.error, json: opts.json };
}

export async function reviewReject(
  opts: ReviewActionOptions,
): Promise<ReviewActionCommandResult> {
  if (!opts.reason || opts.reason.trim().length === 0) {
    return { success: false, action: "reject", error: "--reason is required", json: opts.json };
  }
  const resolved = await resolveSource(opts.paths, opts.sourceName);
  if ("error" in resolved) return { success: false, action: "reject", error: resolved.error, json: opts.json };
  const r = await rejectSubmission(resolved.source, opts.id, opts.reason.trim());
  return { success: r.success, action: "reject", submission: r.submission, error: r.error, json: opts.json };
}

export async function reviewRequestChanges(
  opts: ReviewActionOptions,
): Promise<ReviewActionCommandResult> {
  if (!opts.comment || opts.comment.trim().length === 0) {
    return { success: false, action: "request-changes", error: "--message is required", json: opts.json };
  }
  const resolved = await resolveSource(opts.paths, opts.sourceName);
  if ("error" in resolved) return { success: false, action: "request-changes", error: resolved.error, json: opts.json };
  const r = await requestChanges(resolved.source, opts.id, opts.comment.trim());
  return { success: r.success, action: "request-changes", submission: r.submission, error: r.error, json: opts.json };
}

// ── Formatters ───────────────────────────────────────────────

function fmtTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

export function formatReviewList(r: ReviewListResult): string {
  if (!r.success) return `Error: ${r.error}`;
  if (r.json) {
    return JSON.stringify(
      { submissions: r.submissions, total: r.total, page: r.page, per_page: r.per_page },
      null,
      2,
    );
  }
  const subs = r.submissions ?? [];
  if (subs.length === 0) return "No pending submissions assigned to you.";
  const header = `${subs.length} of ${r.total} pending submission(s) (page ${r.page}):\n`;
  const rows = subs.map((s) => {
    const capFlag = s.capability_change ? " [caps changed]" : "";
    return [
      `  ${s.id}`,
      `    status:       ${s.status}${capFlag}`,
      `    version_id:   ${s.package_version_id}`,
      `    submitted_by: ${s.submitted_by}`,
      `    created:      ${fmtTime(s.created_at)}`,
    ].join("\n");
  });
  return header + rows.join("\n\n");
}

function renderValidationResult(raw: unknown): string {
  // Server stores validation_result as a JSON string. Unwrap it and
  // pretty-print so stewards can skim nested findings/discrepancies.
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (typeof parsed === "string") return parsed;
  const pretty = JSON.stringify(parsed, null, 2);
  // Indent every line by 4 so the block aligns under `validation_result:`.
  return pretty.split("\n").map((line) => `    ${line}`).join("\n");
}

export function formatReviewShow(r: ReviewShowResult): string {
  if (!r.success) return `Error: ${r.error}`;
  if (r.json) return JSON.stringify(r.submission, null, 2);
  const s = r.submission;
  if (!s) return "No submission found.";
  const lines = [
    `Submission ${s.id}`,
    `  status:          ${s.status}`,
    `  version_id:      ${s.package_version_id}`,
    `  submitted_by:    ${s.submitted_by}`,
    `  sponsor_id:      ${s.sponsor_id ?? "(none)"}`,
    `  capability_change: ${s.capability_change ? "yes" : "no"}`,
    `  created:         ${fmtTime(s.created_at)}`,
    `  updated:         ${fmtTime(s.updated_at)}`,
    `  reviewed:        ${s.reviewed_at ? fmtTime(s.reviewed_at) : "(not yet)"}`,
  ];
  if (s.review_comment) lines.push(`  review_comment:  ${s.review_comment}`);
  if (s.validation_result) {
    lines.push(`  validation_result:`);
    lines.push(renderValidationResult(s.validation_result));
  }
  return lines.join("\n");
}

export function formatReviewAction(r: ReviewActionCommandResult): string {
  if (r.json) {
    return JSON.stringify(
      r.success
        ? { action: r.action, submission: r.submission }
        : { action: r.action, error: r.error },
      null,
      2,
    );
  }
  if (!r.success) return `Error: ${r.error}`;
  const verbMap = { approve: "approved", reject: "rejected", "request-changes": "changes requested" };
  const verb = verbMap[r.action];
  if (!r.submission) return `Submission ${verb}.`;
  return `Submission ${r.submission.id} — ${verb}. Status: ${r.submission.status}.`;
}
