// Modified for CodeLoop.
import type { MouseEvent } from "react";
import { useBoardConfig, statusDetails } from "../boardConfig";
import { taskStatusSequence, boundStatus, canMoveTask } from "../../../shared/board-config.mjs";
import type { Task, TaskPriority, TaskStatus } from "../types";
import { ActorAvatar } from "./ActorAvatar";
import { LinearIcon, LinearPriorityIcon } from "./LinearIcon";

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "无优先级",
  urgent: "紧急",
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级",
};

interface TaskCardProps {
  task: Task;
  isDragging: boolean;
  dragShift: number;
  isMoving: boolean;
  isSettling: boolean;
  isContextMenuOpen: boolean;
  onEdit: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onOpenThread: (threadId: string) => void;
  onOpenReview: (task: Task) => void;
}

export function TaskCard({
  task,
  isDragging,
  dragShift,
  isMoving,
  isSettling,
  isContextMenuOpen,
  onEdit,
  onContextMenu,
  onMove,
  onDragStart,
  onDragEnd,
  onOpenThread,
  onOpenReview,
}: TaskCardProps) {
  const config = useBoardConfig();
  const dueDate = task.dueDate
    ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(`${task.dueDate}T12:00:00`))
    : null;
  const subIssueTotal = task.relations.subIssues.length;
  const completedSubIssues = task.relations.subIssues.filter((issue) => statusDetails(config, issue.status).category === "done").length;
  const activeBlockers = task.relations.blockedBy.filter((issue) => (
    !["done", "canceled"].includes(statusDetails(config, issue.status).category)
  )).length;
  const statusSequence = taskStatusSequence(task, config).filter((id) => id === task.status || canMoveTask(config, task, id));
  const statusIndex = statusSequence.indexOf(task.status);
  const previousStatus = statusIndex > 0 ? statusSequence[statusIndex - 1] : null;
  const nextStatus = statusIndex >= 0 && statusIndex < statusSequence.length - 1
    ? statusSequence[statusIndex + 1]
    : null;
  const isSystemStatus = task.status === boundStatus(config, "approval");
  const reviewRiskReason = isSystemStatus
    ? task.automationReview?.riskReasons[0]?.trim()
    : null;

  function stopThen(callback: () => void) {
    return (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      callback();
    };
  }

  return (
    <article
      className={`task-card priority-${task.priority}${isDragging ? " is-dragging" : ""}${dragShift ? " is-drag-shifted" : ""}${isMoving ? " is-moving" : ""}${isSettling ? " is-settling" : ""}${isContextMenuOpen ? " is-context-open" : ""}`}
      style={dragShift ? { transform: `translate3d(0, ${dragShift}px, 0)` } : undefined}
      draggable={!isMoving && statusSequence.length > 1}
      aria-labelledby={`task-${task.id}-title`}
      data-task-id={task.id}
      data-drag-shift={dragShift || undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(task, { x: event.clientX, y: event.clientY });
      }}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", task.id);
        event.dataTransfer.setData("application/x-taskboard-task", task.id);
        onDragStart(task, event.currentTarget.offsetHeight);
      }}
      onDragEnd={onDragEnd}
    >
      <button
        className="task-card-open"
        type="button"
        aria-label={`打开 ${task.identifier}: ${task.title}`}
        onClick={() => onEdit(task)}
      />

      <div className="card-topline">
        <span className="card-reference">
          <span className="task-identifier">{task.identifier}</span>
          {task.relations.parent && (
            <>
              <LinearIcon name="chevronRight" />
              <span className="card-parent-title" title={task.relations.parent.title}>
                {task.relations.parent.title}
              </span>
            </>
          )}
        </span>
        <ActorAvatar actor={task.assignee} className="card-assignee-avatar" />
        <div className="card-actions" aria-label="移动议题">
          <button
            className="icon-button compact"
            type="button"
            disabled={previousStatus === null || isMoving}
            aria-label="移到上一状态"
            title="移到上一状态"
            onClick={stopThen(() => {
              if (previousStatus) onMove(task, previousStatus);
            })}
          >
            <LinearIcon name="chevronLeft" />
          </button>
          <button
            className="icon-button compact"
            type="button"
            disabled={nextStatus === null || isMoving}
            aria-label="移到下一状态"
            title="移到下一状态"
            onClick={stopThen(() => {
              if (nextStatus) onMove(task, nextStatus);
            })}
          >
            <LinearIcon name="chevronRight" />
          </button>
        </div>
      </div>

      <h3 id={`task-${task.id}-title`}>{task.title}</h3>

      {reviewRiskReason && (
        <div className="review-risk-reason" title={reviewRiskReason}>
          风险：{reviewRiskReason}
        </div>
      )}

      <div className="card-properties" aria-label="议题属性">
        <span className={`priority-icon priority-icon-${task.priority}`} title={PRIORITY_LABELS[task.priority]}>
          <LinearPriorityIcon priority={task.priority} />
        </span>
        {activeBlockers > 0 && (
          <span className="blocked-by-count" title={`被 ${activeBlockers} 个未完成议题阻塞`}>
            <LinearIcon name="alert" />
            {activeBlockers}
          </span>
        )}
        {subIssueTotal > 0 && (
          <span className="sub-issue-progress-chip" title={`${completedSubIssues}/${subIssueTotal} 个子议题已完成`}>
            <span className="sub-issue-progress" aria-hidden="true" />
            {completedSubIssues}/{subIssueTotal}
          </span>
        )}
        {task.labels.slice(0, 2).map((label) => (
          <span className="label-chip" key={label}>{label}</span>
        ))}
        {task.labels.length > 2 && (
          <span className="label-more" title={task.labels.slice(2).join(", ")}>+{task.labels.length - 2}</span>
        )}
        {dueDate && (
          <span className="due-date-chip" title={`截止日期 ${task.dueDate}`}>
            <LinearIcon name="calendar" /> {dueDate}
          </span>
        )}
        {task.automationReview && (
          <button
            className="review-diff-link"
            type="button"
            onClick={stopThen(() => onOpenReview(task))}
          >
            <LinearIcon name="branch" />
            查看变更
            <span>+{task.automationReview.additions} / -{task.automationReview.deletions}</span>
          </button>
        )}
        {task.threadId && (
          <button
            className="thread-link"
            type="button"
            aria-label={`查看对话 ${task.threadId}`}
            title={`查看对话 ${task.threadId}`}
            onClick={stopThen(() => onOpenThread(task.threadId!))}
          >
            <LinearIcon name="conversation" />
          </button>
        )}
      </div>
    </article>
  );
}
