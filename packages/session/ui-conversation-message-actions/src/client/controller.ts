import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { ISessions, SessionFace } from "@deepseek-ai/dsh-api-session-controller/client";
import type { ObservableSnapshot, SnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { UiWorkspace } from "@deepseek-ai/dsh-client-ui-workspace/client";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-store";
import type { SessionId } from "@deepseek-ai/dsh-session";
import {
  SESSION_EDITOR_PATH,
  type EditableMessageBlock,
  type SessionEditorOperation,
  type SessionEditorOperationResult,
  type SessionEditorTimeline,
  type VersionOperation,
} from "../shared.ts";

function editorApiPath(): string {
  const transport = (globalThis as { __DSH_TRANSPORT__?: { ownsHost?: boolean } })
    .__DSH_TRANSPORT__;
  return transport?.ownsHost === true ? `/api${SESSION_EDITOR_PATH}` : SESSION_EDITOR_PATH;
}

export interface SessionEditorState {
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  pending: VersionOperation | "recall" | null;
  timeline: SessionEditorTimeline | null;
}

export interface SessionEditorFace {
  hooks: { sessionEditor: ObservableSnapshot<SessionEditorState> };
  acquire(): () => void;
  load(): void;
  edit(
    message: EditableMessageBlock,
    text: string,
    cascade: "truncate" | "preserve",
  ): Promise<boolean>;
  retry(turn: number, cascade: "truncate" | "preserve"): Promise<boolean>;
  reroll(): Promise<boolean>;
  rewind(toBoundary: number): Promise<boolean>;
  recall(message: EditableMessageBlock): Promise<boolean>;
  openVersion(sessionId: string): Promise<void>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 自动刷新的合并窗口。会话每次快照通知都拉一次投影，会把流式输出变成每帧一个
 * 请求；窗口内的多次失效合并成一次刷新。
 */
export const AUTO_REFRESH_COALESCE_MS = 250;

export class SessionEditorController {
  readonly store: SnapshotStore<SessionEditorState> = createSnapshotStore<SessionEditorState>({
    status: "idle",
    error: null,
    pending: null,
    timeline: null,
  });

  readonly face: SessionEditorFace;
  private readonly ctx: ClientContext;
  private readonly sessions: ISessions;
  private readonly uiWorkspace: UiWorkspace;
  private sessionSource: SessionFace | undefined;
  private sessionSourceDispose: (() => void) | undefined;
  private listSubscribeDispose: (() => void) | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshChain: Promise<void> = Promise.resolve();
  private disposed = false;
  private users = 0;

  constructor(
    ctx: ClientContext,
    private readonly sessionId: SessionId,
  ) {
    this.ctx = ctx;
    this.sessions = ctx.get("sessions") as unknown as ISessions;
    this.uiWorkspace = ctx.get("uiWorkspace") as unknown as UiWorkspace;
    this.face = {
      hooks: { sessionEditor: this.store },
      acquire: () => {
        this.users += 1;
        if (this.users === 1 && this.disposed) this.revive();
        return () => this.release();
      },
      load: () => {
        void this.load();
      },
      edit: (message, text, cascade) =>
        this.mutate({
          action: "edit",
          sessionId: this.sessionId,
          eventSeq: message.eventSeq,
          blockIndex: message.blockIndex,
          text,
          cascade,
        }),
      retry: (turn, cascade) =>
        this.mutate({ action: "retry", sessionId: this.sessionId, turn, cascade }),
      reroll: () => this.mutate({ action: "reroll", sessionId: this.sessionId }),
      rewind: (toBoundary) =>
        this.mutate({ action: "rewind", sessionId: this.sessionId, toBoundary }),
      recall: (message) =>
        this.mutate(
          { action: "recall", sessionId: this.sessionId, eventSeq: message.eventSeq },
          () => this.setComposerDraft(this.messageTexts(message)),
        ),
      openVersion: (sessionId) => {
        this.uiWorkspace.openSession(sessionId as SessionId);
        return Promise.resolve();
      },
    };
    this.observe();
  }

  private observe(): void {
    this.sessionSource = undefined;
    this.sessionSourceDispose?.();
    this.bindSessionSource();
    this.listSubscribeDispose?.();
    this.listSubscribeDispose = this.sessions.list.subscribe(() => this.invalidate());
  }

  private bindSessionSource(): void {
    const source = this.sessions.binding(this.sessionId)?.session;
    if (source === this.sessionSource) return;
    this.sessionSourceDispose?.();
    this.sessionSource = source;
    this.sessionSourceDispose = source?.subscribe(() => {
      this.invalidate();
    });
  }

  private invalidate(): void {
    if (this.disposed || this.store.getSnapshot().status === "idle") return;

    this.scheduleRefresh();
  }

  /**
   * 合并窗口内的多次失效成一次静默刷新。刷新串行执行，避免并发响应乱序覆盖；
   * 一次刷新在途时的后续失效排到窗口之后，不会丢。
   */
  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refreshChain = this.refreshChain.then(async () => {
        if (!this.disposed) await this.load({ silent: true });
      });
    }, AUTO_REFRESH_COALESCE_MS);
  }

  private release(): void {
    this.users -= 1;
    if (this.users <= 0) this.dispose();
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.sessionSourceDispose?.();
    this.sessionSourceDispose = undefined;
    this.sessionSource = undefined;
    this.listSubscribeDispose?.();
    this.listSubscribeDispose = undefined;
  }

  private revive(): void {
    this.disposed = false;
    this.observe();
    void this.load();
  }

  /**
   * @param options.silent - 后台刷新：不写 `loading`、不清错误，避免面板随每次刷新闪动。
   */
  async load(options: { silent?: boolean } = {}): Promise<void> {
    if (this.disposed) return;
    if (options.silent !== true) {
      this.store.update((state) => {
        state.status = "loading";
        state.error = null;
      });
    }
    try {
      const response = await fetch(
        `${editorApiPath()}?sessionId=${encodeURIComponent(this.sessionId)}`,
        {
          method: "GET",
          headers: { accept: "application/json" },
          cache: "no-store",
        },
      );
      const value = (await response.json()) as unknown;
      if (this.disposed) return;
      if (response.ok) {
        this.store.update((state) => {
          state.status = "ready";
          state.error = null;
          state.timeline = value as SessionEditorTimeline;
        });
      } else {
        const error = (value as { error?: unknown })["error"];
        this.store.update((state) => {
          state.status = "error";
          state.error =
            typeof error === "string" ? error : `请求失败：HTTP ${String(response.status)}`;
        });
      }
    } catch (error) {
      if (this.disposed) return;
      this.store.update((state) => {
        state.status = "error";
        state.error = messageOf(error);
      });
    }
  }

  private async mutate(
    operation: SessionEditorOperation,
    onApplied?: () => void,
  ): Promise<boolean> {
    const current = this.store.getSnapshot();
    if (current.pending !== null) return false;
    this.store.update((state) => {
      state.pending = operation.action;
      state.error = null;
    });
    try {
      const response = await fetch(editorApiPath(), {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(operation),
      });
      const value = (await response.json()) as unknown;
      if (this.disposed) return true;
      if (!response.ok) {
        const error = (value as { error?: unknown })["error"];
        throw new Error(
          typeof error === "string" ? error : `请求失败：HTTP ${String(response.status)}`,
        );
      }
      this.store.update((state) => {
        state.pending = null;
      });

      onApplied?.();
      const result = value as SessionEditorOperationResult;

      if (String(result.sessionId) !== String(this.sessionId)) {
        this.uiWorkspace.openSession(result.sessionId as SessionId);
        return true;
      }

      const face = this.sessions.binding(this.sessionId)?.session;
      const resync = (face as unknown as { resync?: () => Promise<void> }).resync;
      if (resync !== undefined) {
        try {
          await resync.call(face);

          const projections = (
            face as unknown as { projections?: { truncate?(lastSeq: number): void } }
          ).projections;
          if (typeof projections?.truncate !== "function") {
            location.reload();
            return true;
          }
          projections.truncate(-1);
          void this.load();
          return true;
        } catch {}
      }
      location.reload();
      return true;
    } catch (error) {
      if (this.disposed) return false;
      this.store.update((state) => {
        state.pending = null;
        state.error = messageOf(error);
      });
      return false;
    }
  }

  private messageTexts(message: EditableMessageBlock): readonly string[] {
    const prefix = `${String(message.eventSeq)}:`;
    const blocks = (this.store.getSnapshot().timeline?.messages ?? [])
      .filter((row) => row.kind === "user" && row.key.startsWith(prefix))
      .sort((left, right) => left.blockIndex - right.blockIndex)
      .map((row) => row.text);
    return blocks.length === 0 ? [message.text] : blocks;
  }

  private setComposerDraft(texts: readonly string[]): void {
    if (this.sessions.binding(this.sessionId) === undefined) return;
    const scoped = this.sessions.scope(this.sessionId);
    if (scoped === undefined) return;
    const conversation = scoped.get("conversation") as
      | {
          input?: {
            for(ctx: ClientContext): { restoreDraft(draft: string): void };
          };
        }
      | undefined;
    conversation?.input?.for(scoped).restoreDraft(texts.join("\n\n"));
  }
}
