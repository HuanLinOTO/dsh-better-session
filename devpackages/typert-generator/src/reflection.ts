import { type Node, type ParsedFile, jsDocOf } from "./ast.ts";
import type { SchemaIndex, TypeDecl } from "./schema.ts";

// 包反射（`TYPERT.model`）：给运行时与模型看的元数据——服务面、成员、签名、JSDoc 与相关类型声明。
// 全部是 AST 文本（源码 + 声明树），不需要类型图。

export type ReflectionTag = { name: string; argument?: string; comment: string; text: string };

export type ReflectionMember = {
  kind: "method";
  name: string;
  signature: string;
  summary: string;
  jsDoc: string;
};

export type ReflectionService = {
  description: string;
  summary: string;
  tags: ReflectionTag[];
  jsDoc: string;
  key: string;
  exportName: string;
  members: ReflectionMember[];
  types: { name: string; declaration: string }[];
};

export type ReflectionModel = {
  services: ReflectionService[];
  events: unknown[];
  objects: unknown[];
};

type Doc = { raw: string; description: string; summary: string; tags: ReflectionTag[] };

/** 带实参的标签（`@param ns …`）把第一个词单列成 `argument`。 */
const TAG_WITH_ARGUMENT = /^(?:param|arg|argument|property|returns?|throws?|template|type)$/u;

/** JSDoc 原文的四种视图：原文、正文、第一句、标签。 */
function docOf(file: ParsedFile, node: Node): Doc {
  const inner = jsDocOf(file, node);
  if (inner === undefined) return { raw: "", description: "", summary: "", tags: [] };
  const prose: string[] = [];
  const tags: ReflectionTag[] = [];
  for (const line of inner.split("\n").map((text) => text.replace(/^\s*\*?\s?/u, "").trimEnd())) {
    const match = /^@(\S+)\s*(.*)$/u.exec(line);
    if (match === null) {
      if (line.trim() !== "") prose.push(line.trim());
      continue;
    }
    const name = match[1] ?? "";
    const rest = match[2] ?? "";
    const argument = TAG_WITH_ARGUMENT.test(name) ? /^(\S+)\s*(.*)$/u.exec(rest) : null;
    const head = argument?.[1] ?? "";
    const withArgument = argument !== null && head !== "" && !head.includes(".");
    tags.push({
      name,
      ...(withArgument ? { argument: head } : {}),
      comment: (withArgument ? (argument[2] ?? "") : rest).trim(),
      text: `@${name}${rest === "" ? "" : ` ${rest}`}`.trimEnd(),
    });
  }
  const description = prose.join(" ");
  const stop = description.search(/\.\s/u);
  // 原文按标准形态重排：单行 `/** x */`，多行每行 ` * x`（上游产物就是这么落的）。
  const body = inner.split("\n").map((line) => line.replace(/^\s*\*?\s?/u, "").trimEnd());
  while (body.length > 0 && (body[0] ?? "").trim() === "") body.shift();
  while (body.length > 0 && (body.at(-1) ?? "").trim() === "") body.pop();
  const raw =
    body.length === 1 && (body[0] ?? "").trim() !== ""
      ? `/** ${(body[0] ?? "").trim()} */`
      : `/**\n${body.map((line) => (line === "" ? " *" : ` * ${line}`)).join("\n")}\n */`;
  return {
    raw,
    description,
    summary: stop < 0 ? description : description.slice(0, stop + 1),
    tags,
  };
}

/** 方法签名：从装饰器到返回类型压平成一行（产物里就是这么写的）。 */
function signatureOf(file: ParsedFile, method: Node): string {
  const decorators = (method["decorators"] ?? []) as Node[];
  const start = (decorators[0]?.["start"] ?? method["start"]) as number;
  const end = ((method["value"]?.["returnType"] ?? method["value"]) as Node)["end"] as number;
  return file.source.slice(start, end).replace(/\s+/gu, " ").trim();
}

export type ReflectInput = {
  file: ParsedFile;
  /** 取 JSDoc 用的节点：导出语句本身（类的注释在 `export` 之前）。 */
  docNode: Node;
  classNode: Node;
  exportName: string;
  serviceKey: string;
  methods: { method: string; node: Node; typeNames: readonly string[] }[];
};

export function reflectModel(inputs: readonly ReflectInput[], index: SchemaIndex): ReflectionModel {
  const services = inputs.map((input) => {
    const doc = docOf(input.file, input.docNode);
    const typeNames = [...new Set(input.methods.flatMap((method) => [...method.typeNames]))].sort();
    return {
      description: doc.description,
      summary: doc.summary,
      tags: doc.tags,
      jsDoc: doc.raw,
      key: input.serviceKey,
      exportName: input.exportName,
      members: input.methods.map((method) => {
        const memberDoc = docOf(input.file, method.node);
        return {
          kind: "method" as const,
          name: method.method,
          signature: signatureOf(input.file, method.node),
          summary: memberDoc.summary,
          jsDoc: memberDoc.raw,
        };
      }),
      types: typeNames
        .map((name) => index.get(name))
        .filter((decl): decl is TypeDecl => decl !== undefined)
        .map((decl) => ({ name: decl.name, declaration: decl.text })),
    };
  });
  return { services, events: [], objects: [] };
}
