import type { RegistrySource } from "../types.js";
import { combineError } from "./publish.js";

const API_TIMEOUT_MS = 30_000;

function authHeaders(source: RegistrySource): Record<string, string> {
  return { Authorization: `Bearer ${source.token}` };
}

export interface PendingSubmission {
  id: string;
  package_version_id: string;
  submitted_by: string;
  sponsor_id: string;
  status: string;
  capability_change: boolean;
  hold_until: number | null;
  review_comment: string | null;
  created_at: number;
  updated_at: number;
}

export interface PendingListResult {
  success: boolean;
  submissions?: PendingSubmission[];
  total?: number;
  page?: number;
  per_page?: number;
  error?: string;
}

export async function listPending(
  source: RegistrySource,
  page = 1,
  perPage = 20,
): Promise<PendingListResult> {
  try {
    const resp = await fetch(
      `${source.url}/api/v1/review/pending?page=${page}&per_page=${perPage}`,
      { headers: authHeaders(source), signal: AbortSignal.timeout(API_TIMEOUT_MS) },
    );
    const body = (await resp.json().catch(() => ({}))) as {
      submissions?: PendingSubmission[];
      total?: number;
      page?: number;
      per_page?: number;
      error?: unknown;
      message?: unknown;
    };
    if (!resp.ok) {
      return { success: false, error: combineError(body) ?? `HTTP ${resp.status}` };
    }
    return {
      success: true,
      submissions: body.submissions ?? [],
      total: body.total ?? 0,
      page: body.page ?? page,
      per_page: body.per_page ?? perPage,
    };
  } catch (err) {
    return { success: false, error: `Network error: ${(err as Error).message}` };
  }
}

export interface SubmissionDetail {
  id: string;
  package_version_id: string;
  submitted_by: string;
  sponsor_id: string | null;
  status: string;
  validation_result: unknown;
  audit_result: unknown;
  capability_change: boolean;
  hold_until: number | null;
  review_comment: string | null;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ShowResult {
  success: boolean;
  submission?: SubmissionDetail;
  error?: string;
}

export async function getSubmission(
  source: RegistrySource,
  id: string,
): Promise<ShowResult> {
  try {
    const resp = await fetch(`${source.url}/api/v1/review/${encodeURIComponent(id)}`, {
      headers: authHeaders(source),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const body = (await resp.json().catch(() => ({}))) as {
      submission?: SubmissionDetail;
      error?: unknown;
      message?: unknown;
    };
    if (!resp.ok) {
      return { success: false, error: combineError(body) ?? `HTTP ${resp.status}` };
    }
    return { success: true, submission: body.submission };
  } catch (err) {
    return { success: false, error: `Network error: ${(err as Error).message}` };
  }
}

export interface ReviewActionResult {
  success: boolean;
  submission?: SubmissionDetail;
  error?: string;
  statusCode?: number;
}

async function postAction(
  source: RegistrySource,
  id: string,
  action: "approve" | "reject" | "request-changes",
  payload: Record<string, unknown>,
): Promise<ReviewActionResult> {
  try {
    const resp = await fetch(
      `${source.url}/api/v1/review/${encodeURIComponent(id)}/${action}`,
      {
        method: "POST",
        headers: { ...authHeaders(source), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      },
    );
    const body = (await resp.json().catch(() => ({}))) as {
      submission?: SubmissionDetail;
      error?: unknown;
      message?: unknown;
    };
    if (!resp.ok) {
      return {
        success: false,
        error: combineError(body) ?? `HTTP ${resp.status}`,
        statusCode: resp.status,
      };
    }
    return { success: true, submission: body.submission, statusCode: resp.status };
  } catch (err) {
    return { success: false, error: `Network error: ${(err as Error).message}` };
  }
}

export function approveSubmission(
  source: RegistrySource,
  id: string,
): Promise<ReviewActionResult> {
  return postAction(source, id, "approve", {});
}

export function rejectSubmission(
  source: RegistrySource,
  id: string,
  reason: string,
): Promise<ReviewActionResult> {
  return postAction(source, id, "reject", { reason });
}

export function requestChanges(
  source: RegistrySource,
  id: string,
  comment: string,
): Promise<ReviewActionResult> {
  return postAction(source, id, "request-changes", { comment });
}
