// 桌面形态的 **IPC 面**：壳与宿主之间只有一条字节管道（FD 3/4）加一条 Node IPC 通道，这一份是那两头
// 的全部——请求帧的收发、向 `webServer` 的分发、以及收尾。
//
// [`./index.ts`](./index.ts) 只负责「解析 → 装配 → 接线」，协议细节不再混在入口里（以前两者同在
// 一份 347 行的文件里，"入口"与"信道"两件事互相遮掩）。

import { once } from "node:events";
import { createReadStream, createWriteStream, type ReadStream, type WriteStream } from "node:fs";
import type { Context } from "@deepseek-ai/cordis";
import type { AppProfileBoot } from "@morlay/dsh-app-boot";
import { applyInspectorCommand, closeInspectorEndpoint } from "./inspector.ts";
import { errorMessage, fatalEvent } from "./fatal.ts";
import type { PortlessWebServer } from "./webserver.ts";
import {
  DESKTOP_PIPE_CHUNK_BYTES,
  DESKTOP_REQUEST_PIPE_FD,
  DESKTOP_RESPONSE_PIPE_FD,
  DesktopHostRequestDecoder,
  encodeDesktopResponseData,
  encodeDesktopResponseEnd,
  encodeDesktopResponseError,
  encodeDesktopResponseStart,
  isDesktopHostCommand,
  type DesktopHostEvent,
  type DesktopHostRequestFrame,
} from "./wire.ts";

interface PendingRequest {
  readonly abort: AbortController;
  body?: ReadableStreamDefaultController<Uint8Array>;
}

/** 接上壳那两条通道要什么。 */
export interface DesktopIpcOptions {
  /** 装配结果：收尾时取它的 `shutdown`（尚未 settle 也照等，装配失败只当作没有树可停）。 */
  readonly application: Promise<AppProfileBoot>;
  /** 装配好的上下文：写日志用。 */
  readonly ctx: Context;
  /** 宿主内的无端口 `webServer`：所有请求都往它上面分发。 */
  readonly webServer: PortlessWebServer;
}

/** 接好之后的信道两头。 */
export interface DesktopIpc {
  /** 向壳发事件（`ready` / `fatal`）。 */
  readonly send: (event: DesktopHostEvent) => void;
  /** 收尾：停收请求、停树、断开 IPC 通道；幂等。 */
  readonly stop: (exitCode?: number) => Promise<void>;
}

/**
 * 接上 IPC 面：开始收请求帧、按帧分发、并挂好生命周期（`shutdown` 命令 / 通道断开 / 管道出错）。
 * @param options - 装配结果、上下文与 `webServer`。
 * @returns 发事件与收尾两个入口。
 */
export function connectDesktopIpc(options: DesktopIpcOptions): DesktopIpc {
  const { application, ctx, webServer } = options;
  const requestPipe: ReadStream = createReadStream("", {
    fd: DESKTOP_REQUEST_PIPE_FD,
    autoClose: false,
  });
  const responsePipe: WriteStream = createWriteStream("", {
    fd: DESKTOP_RESPONSE_PIPE_FD,
    autoClose: false,
  });
  let responseTail: Promise<void> = Promise.resolve();
  // 收尾阶段壳会关掉管道；此后不再写入，管道本身的错误也只在那一段里吞掉。
  let closing = false;
  responsePipe.on("error", (error) => {
    if (!closing) {
      ctx.logger.error(error);
      process.exitCode = 1;
    }
  });
  const writeResponse = (frame: Buffer): Promise<void> => {
    if (closing || responsePipe.destroyed) return Promise.resolve();
    const write = responseTail.then(async () => {
      if (closing || responsePipe.destroyed) return;
      if (!responsePipe.write(frame)) await once(responsePipe, "drain");
    });
    responseTail = write.catch(() => undefined);
    return write;
  };
  const send = (event: DesktopHostEvent): void => {
    if (process.send === undefined || !process.connected) return;
    try {
      process.send(event);
    } catch (error) {
      // 父进程并发断开时只吞掉通道已关闭这一种；其余照常抛出。
      if ((error as NodeJS.ErrnoException).code !== "ERR_IPC_CHANNEL_CLOSED") throw error;
    }
  };

  const pending = new Map<number, PendingRequest>();
  const runs = new Set<Promise<void>>();
  const decoder = new DesktopHostRequestDecoder();
  let lastStreamId = 0;
  let stopping: Promise<void> | undefined;

  const dispatch = async (
    streamId: number,
    request: Request,
    entry: PendingRequest,
  ): Promise<void> => {
    try {
      // 页面现在从**真 webServer 的 origin**（`http://127.0.0.1:<port>`）载入，请求直连它——这条字节管道
      // 不再承载任何请求（壳侧即使还写着也没人需要）。这里不再去摸 `dispatch`：真 webServer 没有这个方法，
      // 而以前那个"无端口替身"才提供它。
      if (typeof (webServer as { dispatch?: unknown }).dispatch !== "function") {
        await writeResponse(encodeDesktopResponseStart(streamId, {
          status: 404,
          headers: [["content-type", "text/plain; charset=utf-8"]],
          hasBody: true,
        }));
        await writeResponse(encodeDesktopResponseData(streamId, Buffer.from("not found")));
        await writeResponse(encodeDesktopResponseEnd(streamId));
        pending.delete(streamId);
        return;
      }
      const response = await webServer.dispatch(request);
      await writeResponse(
        encodeDesktopResponseStart(streamId, {
          status: response.status,
          headers: [...response.headers.entries()],
          hasBody: response.body !== null,
        }),
      );
      if (response.body !== null) {
        for await (const chunk of response.body) {
          const bytes = Buffer.from(chunk);
          for (let offset = 0; offset < bytes.byteLength; offset += DESKTOP_PIPE_CHUNK_BYTES) {
            if (!pending.has(streamId)) return;
            await writeResponse(
              encodeDesktopResponseData(
                streamId,
                bytes.subarray(offset, offset + DESKTOP_PIPE_CHUNK_BYTES),
              ),
            );
          }
        }
      }
      await writeResponse(encodeDesktopResponseEnd(streamId));
    } catch (error) {
      if (!entry.abort.signal.aborted) {
        await writeResponse(encodeDesktopResponseError(streamId, errorMessage(error))).catch(
          () => {},
        );
      }
    } finally {
      pending.delete(streamId);
    }
  };

  const handleFrame = (frame: DesktopHostRequestFrame): void => {
    if (frame.type === "start") {
      if (frame.streamId <= lastStreamId)
        throw new Error(`dsh desktop: request stream ${String(frame.streamId)} is not in order`);
      lastStreamId = frame.streamId;
      const entry: PendingRequest = { abort: new AbortController() };
      const streamId = frame.streamId;
      const body = frame.hasBody
        ? new ReadableStream<Uint8Array>({
            start: (controller) => {
              entry.body = controller;
            },
            cancel: () => {
              entry.abort.abort();
            },
          })
        : undefined;
      pending.set(streamId, entry);
      const request = new Request(frame.url, {
        method: frame.method,
        headers: frame.headers,
        signal: entry.abort.signal,
        ...(body === undefined ? {} : { body, duplex: "half" }),
      } as RequestInit & { duplex?: "half" });
      const run = dispatch(streamId, request, entry).catch((error: unknown) => {
        ctx.logger.warn(error instanceof Error ? error : new Error(errorMessage(error)));
      });
      runs.add(run);
      void run.finally(() => runs.delete(run));
      return;
    }
    const entry = pending.get(frame.streamId);
    if (entry === undefined) return;
    switch (frame.type) {
      case "data": {
        // 桌面请求体很小，直接入队；不做管道 pause（pause 靠 body 流的 pull 恢复，
        // 一旦 body 提前销毁就再没人解除，会卡死后续请求帧）。
        entry.body?.enqueue(frame.data);
        return;
      }
      case "end":
        entry.body?.close();
        return;
      case "cancel":
        entry.abort.abort();
        return;
      default:
        return;
    }
  };

  const stop = (exitCode = 0): Promise<void> => {
    stopping ??= (async () => {
      closing = true;
      closeInspectorEndpoint();
      requestPipe.pause();
      requestPipe.destroy();
      for (const entry of pending.values()) entry.abort.abort();
      pending.clear();
      const running = await application.catch(() => undefined);
      await running?.shutdown.shutdown(exitCode);
      await Promise.allSettled(runs);
      await responseTail.catch(() => undefined);
      if (!responsePipe.destroyed) responsePipe.destroy();
      if (process.connected) process.disconnect?.();
      process.exitCode = exitCode;
    })();
    return stopping;
  };

  requestPipe.on("data", (chunk: Buffer) => {
    let frames: DesktopHostRequestFrame[];
    try {
      frames = decoder.push(chunk);
      for (const frame of frames) handleFrame(frame);
    } catch (error) {
      send(fatalEvent(error));
      void stop(1);
    }
  });
  requestPipe.once("error", (error) => {
    send(fatalEvent(error));
    void stop(1);
  });
  requestPipe.once("end", () => {
    try {
      decoder.finish();
    } catch (error) {
      send(fatalEvent(error));
      void stop(1);
    }
  });
  process.on("message", (message: unknown) => {
    if (!isDesktopHostCommand(message)) return;
    // 调试端点命令先于 shutdown 分派：它们只影响回环上的 Node inspector。
    const inspected = applyInspectorCommand(message);
    if (inspected !== undefined) {
      send(inspected);
      return;
    }
    if (message.type === "shutdown") void stop();
  });
  process.once("disconnect", () => {
    void stop();
  });

  return { send, stop };
}
