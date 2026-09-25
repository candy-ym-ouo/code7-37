import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSubmission,
  createSubmissionId,
  discardRecoverableSubmission,
  findRecoverableSubmission,
  idempotencyKeyFor,
  startSubmission,
  updateSubmission
} from "./submission-recovery";

const STORAGE_KEY = "map.submission-recovery.v1";

function storageMock(): Storage {
  let data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => { data = new Map(); },
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, value); }
  };
}

describe("submission recovery store", () => {
  let storage: Storage;

  beforeEach(() => {
    storage = storageMock();
    vi.stubGlobal("localStorage", storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sample(mode: "create" | "edit-draft" | "new-revision" = "create", featureId: string | null = null) {
    return startSubmission({
      mode,
      featureId,
      payload: { title: "长椅", mediaIds: [] },
      mediaIds: ["11111111-1111-4111-8111-111111111111"]
    });
  }

  it("generates stable, distinct idempotency keys per stage", () => {
    const id = createSubmissionId();
    expect(id.length).toBe(32);
    expect(idempotencyKeyFor("create", id)).not.toBe(idempotencyKeyFor("submit", id));
    expect(idempotencyKeyFor("create", id)).toBe(idempotencyKeyFor("create", id));
  });

  it("persists a create-mode recovery point and finds it on the new submission page", () => {
    const submission = sample("create");
    expect(findRecoverableSubmission(null)?.submissionId).toBe(submission.submissionId);
    // 编辑页不应看到属于其他投稿的恢复点。
    expect(findRecoverableSubmission("22222222-2222-4222-8222-222222222222")).toBeNull();
  });

  it("binds edit-mode recovery points to their feature id", () => {
    const featureId = "33333333-3333-4333-8333-333333333333";
    const submission = sample("edit-draft", featureId);
    expect(findRecoverableSubmission(featureId)?.submissionId).toBe(submission.submissionId);
    expect(findRecoverableSubmission(null)).toBeNull();
    // 草稿创建成功后即使路由参数晚到也能靠 draftFeatureId 找回。
    updateSubmission(submission.submissionId, { draftFeatureId: featureId });
    expect(findRecoverableSubmission(featureId)?.submissionId).toBe(submission.submissionId);
  });

  it("keeps the newest recovery point when several exist for the same scope", () => {
    const first = sample("create");
    const second = sample("create");
    const found = findRecoverableSubmission(null);
    expect(found?.submissionId).toBe(second.submissionId);
    expect(found?.submissionId).not.toBe(first.submissionId);
  });

  it("removes recovery points on clear and discard", () => {
    const submission = sample("create");
    clearSubmission(submission.submissionId);
    expect(findRecoverableSubmission(null)).toBeNull();

    const other = sample("create");
    discardRecoverableSubmission(other.submissionId);
    expect(findRecoverableSubmission(null)).toBeNull();
  });

  it("ignores records older than 24 hours", () => {
    const submission = sample("create");
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const raw = storage.getItem(STORAGE_KEY);
    const parsed = JSON.parse(raw!) as Array<Record<string, unknown>>;
    const mutated = parsed.map((item) =>
      item.submissionId === submission.submissionId ? { ...item, updatedAt: stale } : item
    );
    storage.setItem(STORAGE_KEY, JSON.stringify(mutated));
    expect(findRecoverableSubmission(null)).toBeNull();
  });

  it("tracks stage transitions through the submit pipeline", () => {
    const submission = sample("create");
    expect(submission.stage).toBe("creating-draft");
    const updated = updateSubmission(submission.submissionId, {
      stage: "submitting",
      draftFeatureId: "44444444-4444-4444-8444-444444444444"
    });
    expect(updated?.stage).toBe("submitting");
    expect(updated?.draftFeatureId).toBe("44444444-4444-4444-8444-444444444444");
  });
});
