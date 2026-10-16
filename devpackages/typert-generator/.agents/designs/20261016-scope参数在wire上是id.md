# scope 参数在 wire 上是 id，不是宿主对象

## 事实

`@RemoteScope` 的方法（以及"第一个参数的类型命中上下文查找表"的方法）在 wire 上的载荷是**一个 id**，
不是宿主侧那个上下文对象：

```ts
// 宿主侧的源码签名
list(agent: Agent): readonly CommandDescriptor[]

// 生成的 descriptor（host 面）
{ name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent',
  codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-session/types#SessionId', create: … } }
```

`wire` 名是 `${查找表 key}Id`（key 取的是 `TypertLookupMap` 里的键，例如
`agent: TypertLookup<Agent, SessionId>` → `agentId`），**不是参数名**——两者恰好相同时才会看着一致。

## 因此生成器的两条约束

1. **descriptor 的 `wire`**：取查找表的 key（`scopeHit.wire`），不要拿参数名兜底。上游的写法是
   ```ts
   wire: `${lookup.key}Id`; // analyzer.ts
   ```
2. **客户端参数的 schema**：按 **id 的类型**生成（`SessionId` → `z.string()`），**不能**按参数节点声明的
   宿主对象类型生成（`Agent` → `z.object({ id: … })`）。后者会让客户端发对象、服务端按字符串 `parse`，
   gateway 报：

   ```
   gateway/input-invalid: typert gateway: commands/list:
   wire field "agentId" failed boundary validation
   ```

## 与 `acceptsUndefined` 的分工

两者都会在 gateway 的 `decode` 路径上体现，但管的是不同的事：

- `acceptsUndefined: true`（可选参数）→ 影响 `missing` 判定，缺字段时不再算错，报错类型是
  `gateway/arguments-invalid`；
- 上面那条 schema 形态 → 值本身过不了 strict codec，报错类型是 `gateway/input-invalid`。

排查时先看报错类型：`arguments-invalid` 往字段有没有上想，`input-invalid` 往值的形态上想。
