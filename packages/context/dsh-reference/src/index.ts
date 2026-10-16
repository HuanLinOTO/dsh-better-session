import type { Context } from "@deepseek-ai/cordis";
import type { PreStepDecision } from "@deepseek-ai/dsh-agent";
import type { FileSystem } from "@deepseek-ai/dsh-fs";
import { findReferences, parseReferenceToken } from "@morlay/dsh-client-ui-primitives/reference";
import { fromMarkdown } from "mdast-util-from-markdown";
import { createUserMessage, type ContentBlock } from "@deepseek-ai/dsh-llm";
import type { UserMessage } from "@deepseek-ai/dsh-session";
import {
  isUserInvocable,
  renderSkillContent,
  type SkillInvocationSource,
} from "@deepseek-ai/dsh-skill";

export const name = "reference";

export const inject = ["skills"];

// 用户显式引用的文件内容注入：`references` 按注入顺序列出这条消息里实际装了的引用（含行窗口）。
export interface FileReferenceSource {
  readonly kind: "file-reference";
  readonly references: readonly FileReference[];
}

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "file-reference": FileReferenceSource;
  }
}

// 内容之外的一条说明（见层级设计「内容之外的说明」）：不说来源，模型会再 read 一遍同一段内容。
// 与内容同处一条消息，所以同一步有多个引用时它也只说一次。
const NOTE = [
  "<system-reminder>",
  "这些文件内容是按你消息里的 @ 引用刚读取的，直接用它即可，不必再 read 一遍。",
  "</system-reminder>",
].join("\n");

export function apply(ctx: Context): void {
  ctx.on("agent/pre-step", async ({ agent, messages, signal }, next): Promise<PreStepDecision> => {
    const decision = await next();
    if (decision.kind === "reject") return decision;
    // 注入跟着工具走：文件引用要有 `read` 能力、skill 引用要有 `skill` 工具，没有对应工具时注入也没有意义。
    // 工具服务是可选的（没声明 `inject` 时 `ctx.get` 会抛，这里自己兜住）：取不到就按解析结果照常展开。
    const tools = ((): unknown => {
      try {
        return ctx.get("tools");
      } catch {
        return undefined;
      }
    })() as { get(name: string, agent: unknown): unknown } | undefined;
    const hasTool = (name: string): boolean =>
      tools === undefined || tools.get(name, agent) !== undefined;
    const hasRead = hasTool("read");
    const hasSkill = hasTool("skill");
    const names = hasSkill ? skillNamesIn(messages) : [];
    const files = hasRead ? fileReferencesIn(messages) : [];
    if (names.length === 0 && files.length === 0) return decision;
    signal.throwIfAborted();
    const cwd = agent.session.header.cwd;
    const injections: UserMessage[] = [];
    for (const name of names) {
      const skill = await ctx.skills.get(name, { cwd, signal, scope: agent });
      signal.throwIfAborted();

      if (skill === undefined || !isUserInvocable(skill)) continue;
      const source: SkillInvocationSource = {
        kind: "skill-invocation",
        name,
        form: "instructions",
      };
      injections.push(
        createUserMessage({
          content: [{ type: "text", text: renderSkillContent(skill) }],
          source,
        }),
      );
    }
    // `ctx.fs` 是可选能力：没有文件系统的部署里 skill 注入照常，文件引用保持普通文本。
    const fs = ctx.get("fs");
    const read: FileReference[] = [];
    const envelopes: ContentBlock[] = [];
    for (const reference of files) {
      const envelope =
        fs === undefined ? undefined : await readFileContent(fs, reference, { cwd, signal });
      signal.throwIfAborted();
      if (envelope === undefined) continue;
      read.push(reference);
      envelopes.push({ type: "text", text: envelope });
    }
    if (read.length > 0) {
      injections.push(
        createUserMessage({
          content: [{ type: "text", text: NOTE }, ...envelopes],
          source: { kind: "file-reference", references: read },
        }),
      );
    }
    if (injections.length === 0) return decision;
    return { ...decision, messages: [...decision.messages, ...injections] };
  });
}

// ── merged from links.ts（win32 构建把相对模块当 external 的规避，见 PR）──


const SKILL_PROTOCOL = "skill";

const FILE_PROTOCOL = "file";

const AT_PREFIX = "@";

interface MarkdownNode {
  readonly type: string;
  readonly value?: string;
  readonly children?: readonly MarkdownNode[];
}

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function inlineCodeSkillNames(text: string): string[] {
  const names: string[] = [];
  const root = fromMarkdown(text) as unknown as MarkdownNode;
  walk(root, (node) => {
    if (node.type !== "inlineCode" || node.value === undefined) return;
    const reference = parseReferenceToken(node.value);
    if (reference?.protocol === SKILL_PROTOCOL && reference.path !== undefined) {
      names.push(reference.path);
    }
  });
  return names;
}

// 注入只能由用户自己的手势触发：外部文本伪造不了 `source.kind === 'user'`。
function forEachTextBlock(messages: readonly UserMessage[], visit: (text: string) => void): void {
  for (const message of messages) {
    if ((message.source as { kind?: unknown }).kind !== "user") continue;
    for (const block of message.content) {
      if (block.type !== "text") continue;
      visit(block.text);
    }
  }
}

export function skillNamesIn(messages: readonly UserMessage[]): string[] {
  const names: string[] = [];
  const push = (name: string | undefined): void => {
    if (name === undefined || name === "" || names.includes(name)) return;
    names.push(name);
  };
  forEachTextBlock(messages, (text) => {
    for (const span of findReferences(text)) {
      if (span.reference.protocol !== SKILL_PROTOCOL) continue;
      push(span.reference.path);
    }
    for (const name of inlineCodeSkillNames(text)) push(name);
  });
  return names;
}

export interface FileReference {
  readonly path: string;
  readonly lineStart?: number;
  readonly lineEnd?: number;
}

// 只认 `@` 起手的路径：`file:x` 与 `[label](x)` 都是普通文本；列在 read 里没有语义，丢弃。
export function fileReferencesIn(messages: readonly UserMessage[]): FileReference[] {
  const references: FileReference[] = [];
  forEachTextBlock(messages, (text) => {
    for (const span of findReferences(text)) {
      const reference = span.reference;
      if (text[span.start] !== AT_PREFIX || reference.protocol !== FILE_PROTOCOL) continue;
      const path = reference.path;
      if (path === undefined || path === "") continue;
      const lineStart = reference.lineStart;
      const next: FileReference = {
        path,
        ...(lineStart === undefined ? {} : { lineStart }),
        ...(lineStart === undefined || reference.lineEnd === undefined
          ? {}
          : { lineEnd: reference.lineEnd }),
      };
      if (references.some((known) => sameWindow(known, next))) continue;
      references.push(next);
    }
  });
  return references;
}

function sameWindow(left: FileReference, right: FileReference): boolean {
  return (
    left.path === right.path && left.lineStart === right.lineStart && left.lineEnd === right.lineEnd
  );
}

// ── merged from file-content.ts ──


// 与 `@deepseek-ai/dsh-tool-fs` 的 read 默认一致：同一份文件在 read 与注入两条路上看到同一个窗口。
const READ_LIMIT = 2000;

const READ_MAX_LINE_LENGTH = 2000;

const READ_MAX_BYTES = 50 * 1024;

const STREAM_MIN_SIZE = 10 * 1024 * 1024;

interface Line {
  readonly number: number;
  readonly text: string;
}

interface Window {
  readonly lines: readonly Line[];
  readonly totalLines: number;
  readonly truncatedByBytes: boolean;
}

export interface FileReadRequest {
  readonly cwd: string | undefined;
  readonly signal: AbortSignal;
}

// 读不出「存在且是普通文本文件」就返回 undefined：引用保持普通文本，本步照常进行。
export async function readFileContent(
  fs: FileSystem,
  reference: FileReference,
  request: FileReadRequest,
): Promise<string | undefined> {
  const offset = reference.lineStart ?? 1;
  const limit =
    reference.lineEnd === undefined ? READ_LIMIT : Math.max(1, reference.lineEnd - offset + 1);
  try {
    const target = await fs.resolve(reference.path, {
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      signal: request.signal,
    });
    const info = await fs.stat(target, request.signal);
    if (info === undefined || info.type !== "file") return undefined;
    const chunks =
      info.size === undefined || info.size >= STREAM_MIN_SIZE
        ? await fs.streamText(target, request.signal)
        : [await fs.readText(target, request.signal)];
    const window = await buildWindow(chunks, { offset, limit });
    if (window === undefined) return undefined;
    return formatFileContent(target.displayPath, {
      offset,
      lines: window.lines,
      totalLines: window.totalLines,
      truncatedByBytes: window.truncatedByBytes,
    });
  } catch {
    request.signal.throwIfAborted();
    return undefined;
  }
}

// 与 read 的窗口语义同构：扫到文件末尾拿准确总行数，只保留窗口内的行，字节/单行上限到顶就停。
async function buildWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  window: { readonly offset: number; readonly limit: number },
): Promise<Window | undefined> {
  const lines: Line[] = [];
  let totalLines = 0;
  let outputBytes = 0;
  let truncatedByBytes = false;
  let lineBuffer = "";
  const lineBufferCap = READ_MAX_LINE_LENGTH + 1;

  const append = (segment: string): void => {
    if (lineBuffer.length >= lineBufferCap) return;
    lineBuffer += segment;
    if (lineBuffer.length > lineBufferCap) lineBuffer = lineBuffer.slice(0, lineBufferCap);
  };

  const flush = (): void => {
    const raw = lineBuffer.endsWith("\r") ? lineBuffer.slice(0, -1) : lineBuffer;
    lineBuffer = "";
    totalLines += 1;
    if (truncatedByBytes || totalLines < window.offset || lines.length >= window.limit) return;
    const text =
      raw.length > READ_MAX_LINE_LENGTH
        ? `${raw.slice(0, READ_MAX_LINE_LENGTH)}... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`
        : raw;
    const bytes = Buffer.byteLength(text, "utf8") + (lines.length > 0 ? 1 : 0);
    if (outputBytes + bytes > READ_MAX_BYTES) {
      truncatedByBytes = true;
      return;
    }
    outputBytes += bytes;
    lines.push({ number: totalLines, text });
  };

  for await (const chunk of chunks) {
    let start = 0;
    let newline = chunk.indexOf("\n", start);
    while (newline !== -1) {
      append(chunk.slice(start, newline));
      flush();
      start = newline + 1;
      newline = chunk.indexOf("\n", start);
    }
    append(chunk.slice(start));
  }
  if (lineBuffer.length > 0) flush();

  const beyondEof =
    !truncatedByBytes && window.offset > totalLines && !(totalLines === 0 && window.offset === 1);
  if (beyondEof) return undefined;
  return { lines, totalLines, truncatedByBytes };
}

// 本步引用的文件内容：内容块形态（见上下文注入规则），行窗口信息与续读提示在信封内。
function formatFileContent(
  displayPath: string,
  outcome: {
    readonly offset: number;
    readonly lines: readonly Line[];
    readonly totalLines: number;
    readonly truncatedByBytes: boolean;
  },
): string {
  const endLine = outcome.lines.at(-1)?.number ?? Math.max(0, outcome.offset - 1);
  let footer: string;
  if (outcome.truncatedByBytes) {
    footer = `(Output capped. Showing lines ${outcome.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`;
  } else if (endLine < outcome.totalLines) {
    footer = `(Showing lines ${outcome.offset}-${endLine} of ${outcome.totalLines}. Use offset=${endLine + 1} to continue.)`;
  } else {
    footer = `(End of file - total ${outcome.totalLines} lines)`;
  }
  const body =
    outcome.lines.length === 0
      ? footer
      : `${outcome.lines.map((line) => `${line.number}: ${line.text}`).join("\n")}\n\n${footer}`;
  return `<file_content path="${displayPath.replaceAll('"', "&quot;")}">
${body}
</file_content>`;
}
