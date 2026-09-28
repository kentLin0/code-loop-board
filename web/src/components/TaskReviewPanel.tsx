import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ApiError,
  approveAutomationReview,
  getAutomationReview,
  getAutomationReviewDiff,
  rejectAutomationReview,
} from "../api";
import type {
  AutomationReviewFile,
  AutomationReviewSummary,
  ReviewDiffChunk,
  Task,
} from "../types";
import { DiffCode } from "./DiffCode";

interface TaskReviewPanelProps {
  task: Task;
  onReviewChanged: () => void | Promise<void>;
  onError: (message: string | null) => void;
  onAnnounce: (message: string) => void;
}

interface LoadFileOptions {
  allowSnapshotRefresh?: boolean;
}

interface LoadReviewOptions {
  allowInitialFileRefresh?: boolean;
  announceSnapshotRefresh?: boolean;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "操作未完成，请重试。";
}

function fileKey(file: AutomationReviewFile): string {
  return `${file.repository}\u0000${file.path}`;
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    added: "新增",
    copied: "复制",
    deleted: "删除",
    modified: "修改",
    renamed: "重命名",
    unmerged: "冲突",
  };
  return labels[status.toLowerCase()] ?? status;
}

function reviewStatusLabel(status: AutomationReviewSummary["status"]): string {
  return {
    pending: "等待审批",
    approved: "已批准",
    rejected: "已驳回",
    stale: "快照已过期",
  }[status];
}

function isSnapshotConflict(error: unknown): boolean {
  return error instanceof ApiError && (
    error.status === 409
    || error.code.includes("STALE")
    || error.code.includes("VERSION")
  );
}

export function TaskReviewPanel({
  task,
  onReviewChanged,
  onError,
  onAnnounce,
}: TaskReviewPanelProps) {
  const [review, setReview] = useState<AutomationReviewSummary | null>(null);
  const [selectedFile, setSelectedFile] = useState<AutomationReviewFile | null>(null);
  const [chunks, setChunks] = useState<ReviewDiffChunk[]>([]);
  const [loadingFile, setLoadingFile] = useState(false);
  const [decisionPending, setDecisionPending] = useState<"approve" | "reject" | null>(null);
  const [loading, setLoading] = useState(true);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [decisionResult, setDecisionResult] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [approveComment, setApproveComment] = useState("");
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const reviewControllerRef = useRef<AbortController | null>(null);
  const fileControllerRef = useRef<AbortController | null>(null);
  const reviewRequestRef = useRef(0);
  const fileRequestRef = useRef(0);
  const loadReviewRef = useRef<((options?: LoadReviewOptions) => Promise<void>) | null>(null);

  const loadFile = useCallback(async (
    file: AutomationReviewFile,
    { allowSnapshotRefresh = true }: LoadFileOptions = {},
  ) => {
    fileControllerRef.current?.abort();
    const requestId = ++fileRequestRef.current;
    const controller = new AbortController();
    fileControllerRef.current = controller;
    setSelectedFile(file);
    setChunks([]);
    setFileError(null);
    setLoadingFile(true);
    try {
      const chunk = await getAutomationReviewDiff(task.id, {
        repository: file.repository,
        path: file.path,
        startLine: 0,
      }, controller.signal);
      if (controller.signal.aborted || requestId !== fileRequestRef.current) return;
      setChunks([chunk]);
    } catch (error) {
      if ((error as Error).name === "AbortError" || requestId !== fileRequestRef.current) return;
      if (isSnapshotConflict(error) && allowSnapshotRefresh) {
        await loadReviewRef.current?.({
          allowInitialFileRefresh: false,
          announceSnapshotRefresh: true,
        });
        return;
      }
      setFileError(messageFor(error));
    } finally {
      if (requestId === fileRequestRef.current) setLoadingFile(false);
    }
  }, [task.id]);

  const loadReview = useCallback(async ({
    allowInitialFileRefresh = true,
    announceSnapshotRefresh = false,
  }: LoadReviewOptions = {}) => {
    reviewControllerRef.current?.abort();
    fileControllerRef.current?.abort();
    const reviewRequestId = ++reviewRequestRef.current;
    fileRequestRef.current += 1;
    const controller = new AbortController();
    reviewControllerRef.current = controller;
    setLoading(true);
    setReviewError(null);
    setDecisionResult(null);
    setReview(null);
    setSelectedFile(null);
    setChunks([]);
    setFileError(null);
    setLoadingFile(false);
    try {
      const nextReview = await getAutomationReview(task.id, controller.signal);
      if (controller.signal.aborted || reviewRequestId !== reviewRequestRef.current) return;
      setReview(nextReview);
      const firstFile = nextReview.files[0] ?? null;
      if (firstFile) {
        await loadFile(firstFile, { allowSnapshotRefresh: allowInitialFileRefresh });
      }
      if (announceSnapshotRefresh && reviewRequestId === reviewRequestRef.current) {
        onAnnounce("审批快照已刷新，已加载最新变更。");
      }
    } catch (error) {
      if (
        (error as Error).name === "AbortError"
        || reviewRequestId !== reviewRequestRef.current
      ) return;
      const message = messageFor(error);
      setReviewError(message);
      onError(message);
    } finally {
      if (!controller.signal.aborted && reviewRequestId === reviewRequestRef.current) setLoading(false);
    }
  }, [loadFile, onAnnounce, onError, task.id]);

  loadReviewRef.current = loadReview;

  useEffect(() => {
    void loadReview();
    return () => {
      reviewControllerRef.current?.abort();
      fileControllerRef.current?.abort();
    };
  }, [loadReview, task.automationReview?.version]);

  const filteredFiles = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!review || !query) return review?.files ?? [];
    return review.files.filter((file) => (
      file.path.toLowerCase().includes(query) || file.repository.toLowerCase().includes(query)
    ));
  }, [filter, review]);

  async function loadMore() {
    const lastChunk = chunks.at(-1);
    if (!selectedFile || !lastChunk?.hasMore || lastChunk.nextStartLine === null || loadingFile) return;
    fileControllerRef.current?.abort();
    const selectedKey = fileKey(selectedFile);
    const requestId = ++fileRequestRef.current;
    const controller = new AbortController();
    fileControllerRef.current = controller;
    setFileError(null);
    setLoadingFile(true);
    try {
      const chunk = await getAutomationReviewDiff(task.id, {
        repository: selectedFile.repository,
        path: selectedFile.path,
        startLine: lastChunk.nextStartLine,
      }, controller.signal);
      if (
        controller.signal.aborted
        || requestId !== fileRequestRef.current
        || selectedKey !== fileKey(selectedFile)
      ) return;
      setChunks((current) => {
        const currentLast = current.at(-1);
        if (currentLast?.nextStartLine !== chunk.startLine) return current;
        return [...current, chunk];
      });
    } catch (error) {
      if ((error as Error).name === "AbortError" || requestId !== fileRequestRef.current) return;
      if (isSnapshotConflict(error)) {
        await loadReviewRef.current?.({
          allowInitialFileRefresh: false,
          announceSnapshotRefresh: true,
        });
        return;
      }
      setFileError(messageFor(error));
    } finally {
      if (requestId === fileRequestRef.current) setLoadingFile(false);
    }
  }

  async function handleDecision(kind: "approve" | "reject") {
    if (!review || decisionPending || review.status !== "pending") return;
    const reason = rejectReason.trim();
    if (kind === "reject" && !reason) return;
    setDecisionPending(kind);
    setDecisionResult(null);
    onError(null);
    try {
      const updated = kind === "approve"
        ? await approveAutomationReview(
            task.id,
            review.id,
            review.version,
            approveComment.trim() || undefined,
          )
        : await rejectAutomationReview(task.id, review.id, review.version, reason);
      setReview((current) => current ? { ...current, ...updated, totals: current.totals } : current);
      setRejectOpen(false);
      const result = kind === "approve" ? "审批已批准，任务列表已刷新。" : "审批已驳回，任务列表已刷新。";
      setDecisionResult(result);
      onAnnounce(result);
      try {
        await onReviewChanged();
      } catch (error) {
        onError(`审批已提交，但任务列表刷新失败：${messageFor(error)}`);
      }
    } catch (error) {
      if (isSnapshotConflict(error)) {
        await loadReview();
        const message = "快照已刷新，请重新检查。";
        setDecisionResult(message);
        onAnnounce(message);
      } else {
        const message = messageFor(error);
        setDecisionResult(message);
        onError(message);
      }
    } finally {
      setDecisionPending(null);
    }
  }

  if (loading) {
    return <div className="task-review-loading" aria-busy="true">正在加载变更审批…</div>;
  }

  if (!review) {
    return (
      <div className="task-review-empty" role={reviewError ? "alert" : undefined}>
        <strong>无法打开变更审批</strong>
        <p>{reviewError ?? "当前任务没有可用的审批快照。"}</p>
        <button className="button secondary" type="button" onClick={() => void loadReview()}>重试</button>
      </div>
    );
  }

  const lastChunk = chunks.at(-1);
  const binaryChunk = chunks.find((chunk) => chunk.binary);
  const diffText = chunks.flatMap((chunk) => chunk.lines).join("\n");
  const decisionReadOnly = review.status !== "pending";
  const decisionDisabled = decisionReadOnly || decisionPending !== null;
  const showRejectReason = decisionReadOnly ? review.status === "rejected" : rejectOpen;

  return (
    <div className="task-review-panel">
      <header className="task-review-summary">
        <div>
          <span>{task.identifier}</span>
          <h2>{task.title}</h2>
          <p>
            {review.totals.files} 个文件
            <strong className="review-additions">+{review.totals.additions}</strong>
            <strong className="review-deletions">-{review.totals.deletions}</strong>
          </p>
        </div>
        <span className={`review-status is-${review.status}`}>{reviewStatusLabel(review.status)}</span>
        {review.riskReasons.length > 0 && (
          <ul className="review-risk-reasons" aria-label="风险原因">
            {review.riskReasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        )}
      </header>

      <div className="task-review-workspace">
        <aside className="review-file-browser" aria-label="变更文件">
          <label>
            <span className="sr-only">筛选文件</span>
            <input
              type="search"
              value={filter}
              placeholder="筛选文件…"
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <div className="review-file-list">
            {filteredFiles.map((file) => (
              <button
                type="button"
                className={fileKey(file) === (selectedFile && fileKey(selectedFile)) ? "is-selected" : ""}
                key={fileKey(file)}
                onClick={() => void loadFile(file)}
              >
                <span className="review-file-status">{statusLabel(file.status)}</span>
                <span className="review-file-path" title={`${file.repository}/${file.path}`}>
                  <strong>{file.path}</strong>
                  <small>{file.repository}{file.previousPath ? ` · 原 ${file.previousPath}` : ""}</small>
                </span>
                <span className="review-file-counts">
                  <i>+{file.additions ?? "—"}</i>
                  <b>-{file.deletions ?? "—"}</b>
                </span>
              </button>
            ))}
            {filteredFiles.length === 0 && <p>没有匹配的文件。</p>}
          </div>
        </aside>

        <section className="review-file-viewer" aria-label="文件差异">
          {selectedFile ? (
            <>
              <header>
                <div>
                  <strong>{selectedFile.path}</strong>
                  <span>{selectedFile.repository} · {statusLabel(selectedFile.status)}</span>
                </div>
                <span>
                  <i>+{selectedFile.additions ?? "—"}</i>
                  <b>-{selectedFile.deletions ?? "—"}</b>
                </span>
              </header>
              <div className="review-diff-viewport">
                {binaryChunk ? (
                  <div className="review-binary-summary">
                    <strong>二进制文件</strong>
                    <p>{binaryChunk.summary ?? "此文件无法显示文本差异。"}</p>
                  </div>
                ) : diffText ? (
                  <DiffCode
                    path={selectedFile.path}
                    language={chunks[0]?.language ?? "text/plain"}
                    lines={diffText}
                  />
                ) : loadingFile ? (
                  <div className="review-file-message" aria-busy="true">正在加载差异…</div>
                ) : fileError ? (
                  <div className="review-file-message" role="alert">
                    <p>{fileError}</p>
                    <button className="button secondary" type="button" onClick={() => void loadFile(selectedFile)}>重试</button>
                  </div>
                ) : chunks.length > 0 ? (
                  <div className="review-file-message">此文件没有可显示的文本差异。</div>
                ) : (
                  <div className="review-file-message">点击左侧文件加载差异。</div>
                )}
              </div>
              {fileError && diffText && <div className="review-load-more-error" role="alert">{fileError}</div>}
              {lastChunk?.hasMore && (
                <button
                  className="review-load-more button secondary"
                  type="button"
                  disabled={loadingFile}
                  onClick={() => void loadMore()}
                >
                  {loadingFile ? "加载中…" : "加载更多"}
                </button>
              )}
            </>
          ) : (
            <div className="review-file-message">此快照没有变更文件。</div>
          )}
        </section>
      </div>

      <footer className="review-decision-bar">
        {decisionResult && <p role="status">{decisionResult}</p>}
            <label className="review-approve-comment">
              <span>审批备注（可选）</span>
              <input
                value={decisionReadOnly ? (review.status === "approved" ? review.decisionComment ?? "" : "") : approveComment}
                disabled={decisionDisabled}
                onChange={(event) => setApproveComment(event.target.value)}
              />
            </label>
            {showRejectReason && (
              <label className="review-reject-editor">
                <span>驳回原因</span>
                <textarea
                  autoFocus={!decisionReadOnly}
                  rows={2}
                  value={decisionReadOnly ? review.decisionComment ?? "" : rejectReason}
                  disabled={decisionDisabled}
                  onChange={(event) => setRejectReason(event.target.value)}
                />
              </label>
            )}
            <div>
              <button
                className="button secondary"
                type="button"
                disabled={decisionDisabled || (rejectOpen && !rejectReason.trim())}
                onClick={() => {
                  if (!rejectOpen) setRejectOpen(true);
                  else void handleDecision("reject");
                }}
              >
                {decisionPending === "reject" ? "正在驳回…" : showRejectReason ? "确认驳回" : "驳回"}
              </button>
              {showRejectReason && (
                <button
                  className="button secondary"
                  type="button"
                  disabled={decisionDisabled}
                  onClick={() => { setRejectOpen(false); setRejectReason(""); }}
                >
                  取消
                </button>
              )}
              <button
                className="button primary"
                type="button"
                disabled={decisionDisabled}
                onClick={() => void handleDecision("approve")}
              >
                {decisionPending === "approve" ? "正在批准…" : "批准变更"}
              </button>
            </div>
        {decisionReadOnly && (
          <p>
            {review.reviewerName ? `${review.reviewerName} · ` : ""}{reviewStatusLabel(review.status)}
            {review.decidedAt ? ` · ${new Date(review.decidedAt).toLocaleString()}` : ""} · 只读快照
          </p>
        )}
      </footer>
    </div>
  );
}
