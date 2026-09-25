/**
 * 投稿提交的前端恢复点。
 *
 * 提交是“创建草稿 → 提交审核”的多请求链路，任何一步都可能因网络/超时失败，
 * 而后端实际可能已经成功。这里把当前链路进度持久化到 localStorage：
 * - 重试时复用同一幂等键，服务端重放原结果，绝不产生第二条草稿；
 * - 页面刷新/误关后重新进入投稿页，提供“继续上次提交”的恢复入口；
 * - 服务端已提交完成时，恢复点直接跳到成功态。
 */

export type SubmitMode = "create" | "edit-draft" | "new-revision";

export type SubmitStage = "creating-draft" | "updating-draft" | "creating-revision" | "submitting";

export type PendingSubmission = {
  /** 恢复点主键，各步骤幂等键均由它派生。 */
  submissionId: string;
  mode: SubmitMode;
  /** edit-draft/new-revision 模式下已有的投稿 ID。 */
  featureId: string | null;
  stage: SubmitStage;
  /** 创建/更新后服务端返回的草稿或修订 ID。 */
  draftFeatureId: string | null;
  revisionId: string | null;
  /** 用于恢复表单的载荷快照。 */
  payload: Record<string, unknown>;
  /** 上传完成的媒体 ID，用于恢复媒体列表。 */
  mediaIds: string[];
  startedAt: string;
  updatedAt: string;
};

const STORAGE_KEY = "map.submission-recovery.v1";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function getStorage(): Storage | null {
  const host = globalThis as { localStorage?: Storage; window?: { localStorage?: Storage } };
  return host.localStorage ?? host.window?.localStorage ?? null;
}

function readAll(): PendingSubmission[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PendingSubmission =>
      typeof item === "object" && item !== null && "submissionId" in item && "stage" in item
    );
  } catch {
    return [];
  }
}

function writeAll(items: PendingSubmission[]): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    if (items.length) storage.setItem(STORAGE_KEY, JSON.stringify(items));
    else storage.removeItem(STORAGE_KEY);
  } catch {
    // 隐私模式/存储满时退化为仅内存，链路在当前页面内仍然安全。
  }
}

function prune(items: PendingSubmission[]): PendingSubmission[] {
  const cutoff = Date.now() - MAX_AGE_MS;
  return items.filter((item) => Date.parse(item.updatedAt) >= cutoff);
}

export function createSubmissionId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 同一恢复点在所有步骤使用稳定且可识别的幂等键（服务端允许 8-128 个可见 ASCII 字符）。 */
export function idempotencyKeyFor(prefix: string, submissionId: string): string {
  return `sub-${prefix}-${submissionId}`.slice(0, 128);
}

export function startSubmission(input: {
  mode: SubmitMode;
  featureId: string | null;
  payload: Record<string, unknown>;
  mediaIds: string[];
}): PendingSubmission {
  const now = new Date().toISOString();
  const submission: PendingSubmission = {
    submissionId: createSubmissionId(),
    mode: input.mode,
    featureId: input.featureId,
    stage: input.mode === "new-revision" ? "creating-revision" : input.mode === "edit-draft" ? "updating-draft" : "creating-draft",
    draftFeatureId: null,
    revisionId: null,
    payload: input.payload,
    mediaIds: input.mediaIds,
    startedAt: now,
    updatedAt: now
  };
  writeAll(prune([...readAll().filter((item) => item.submissionId !== submission.submissionId), submission]));
  return submission;
}

export function updateSubmission(
  submissionId: string,
  patch: Partial<Omit<PendingSubmission, "submissionId" | "startedAt">>
): PendingSubmission | null {
  const items = prune(readAll());
  const index = items.findIndex((item) => item.submissionId === submissionId);
  if (index === -1) return null;
  const updated: PendingSubmission = { ...items[index]!, ...patch, updatedAt: new Date().toISOString() };
  items[index] = updated;
  writeAll(items);
  return updated;
}

export function clearSubmission(submissionId: string): void {
  writeAll(prune(readAll()).filter((item) => item.submissionId !== submissionId));
}

/**
 * 找出当前页面可恢复的提交：
 * - /submit（新建）页面返回 mode=create 的恢复点；
 * - /submit/:id 页面返回匹配该 featureId 的恢复点。
 */
export function findRecoverableSubmission(routeFeatureId: string | null): PendingSubmission | null {
  const items = prune(readAll()).filter((item) => {
    if (routeFeatureId) {
      return item.featureId === routeFeatureId || item.draftFeatureId === routeFeatureId;
    }
    return item.mode === "create";
  });
  // 存储数组按写入顺序追加，取最后一个即最近创建/更新的恢复点
  // （updateSubmission 会以新对象替换原项，保持同一顺序）。
  return items[items.length - 1] ?? null;
}

/** 放弃一个恢复点（用户显式取消）。 */
export function discardRecoverableSubmission(submissionId: string): void {
  clearSubmission(submissionId);
}
