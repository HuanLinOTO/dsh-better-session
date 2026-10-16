import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-chat/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import { UserMessageNodeView } from "./MessageItem.tsx";
import type { SessionEditorController } from "../controller.ts";

const NS = "conversation";

export function registerChatNodeRenderers(
  ctx: Context,
  controllerFor: (sessionId: SessionId) => SessionEditorController,
): void {
  const injectFace = (sessionId: SessionId) => controllerFor(sessionId).face;

  for (const key of ["user", "steering"] as const) {
    ctx.slots.inject("conversation.chat.node", () =>
      ctx.slots.register(
        {
          name: "conversation.chat.node",
          key,
          locale: NS,

          // 图片渲染授权：本渲染器自己渲染用户消息的图片槽（输出图片那个槽不归这里）。
          children: { "conversation.chat.user.images": { kind: "single", scope: "session" } },
          priority: -1,
          inject: injectFace,
        } as never,
        UserMessageNodeView as never,
      ),
    );
  }
}
