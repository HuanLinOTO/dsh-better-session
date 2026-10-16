# 如何写

通用部分（接缝、分层、包出口、代码约定）在[根规范](../../../../.agents/standards/how-to-write.md)；
这里只写本包（typert 产物生成器）特有的约束。

## 规则住在哪

生成器的规则按面分在四份文件里，新增一条规则时改对应的那一份，别把语法活散到别处：

| 规则                                                         | 位置                                           |
| ------------------------------------------------------------ | ---------------------------------------------- |
| 类型语法 → zod（15 种形式、修饰符、递归 `z.lazy`）           | [`src/schema.ts`](../../src/schema.ts)         |
| 方法面与产物文本（命名、格式、`cancellation`、`typeSymbol`） | [`src/index.ts`](../../src/index.ts)           |
| 包反射（JSDoc → description / summary / tags、成员签名）     | [`src/reflection.ts`](../../src/reflection.ts) |
| AST 机械活（解析、遍历、JSDoc、位置）                        | [`src/ast.ts`](../../src/ast.ts)               |

## 两条边界

- **不建类型图、不依赖任何 TypeScript 版本**：两侧输入都是 AST 文本（源码给方法面、声明树给类型面），
  取舍见[设计 用 AST 合成 typert 产物](../designs/20261016-AST合成typert产物.md)。
- **不读上游 tsconfig**：上游配置文件在 patch 阶段就被删掉，生成只按 AST 工作。
