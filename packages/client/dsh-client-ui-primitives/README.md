# @morlay/dsh-client-ui-primitives

对话 UI 与设置页共用的**基础面**：上游那套样式、官方基础组件的统一出口（`Button` / `Menu` / `Input` / `Modal` /
`Switch` / `SettingsForm` / 图标 …）、布局原语（`Stack` / `Row` / `Text`）、这套界面自有的控件（字段行 / 可搜索
选择器 / 标签输入 / 图标按钮 …）、按 schema 自动生成的行配置页，以及引用解析与渲染（host 与 client 共用唯一一份
源码，[`@morlay/dsh-reference`](../../context/dsh-reference/README.md) 的引用展开复用 host 那半）。

样式与控件的写法约束见[规范 how-to-write](./.agents/standards/how-to-write.md)；schema 表单、字段槽与装配形态的
机制见[设计 按 schema 自动生成行配置表单与字段槽注入](./.agents/designs/20260924-schema自动生成行配置表单与字段槽注入.md)。

## 用法

```ts
import { styled, dsw, findReferences } from "@morlay/dsh-client-ui-primitives/client";
```

按 schema 生成的那一页：

```ts
// 插件侧：Config 标 volatile，页面自动出现在该行的配置入口里
export const Config = z.object({
  maxDepth: z.number().step(1).min(0).default(1).volatile(),
});
```

```tsx
// 想给某个字段换控件或只改文案：注册 chain 槽
import {
  SchemaFieldDefault,
  type SchemaFieldComponentProps,
} from "@morlay/dsh-client-ui-primitives/client";

ctx.slots.inject("settings.schema-form.field", () =>
  ctx.slots.register(
    {
      name: "settings.schema-form.field",
      select: (field) => (claim(field) ? { label: "服务商" } : null),
    },
    function ProviderField(field: SchemaFieldComponentProps<{ label: string }>) {
      return <SchemaFieldDefault owner={{ ...field, ...field.matched }} />;
    },
  ),
);
```

设置表单原语：

```ts
import { SettingsFormModel, settingsNumberField } from "@morlay/dsh-client-ui-primitives/client";

const form = new SettingsFormModel(scope, [settingsNumberField("timeoutMs")]);
```

业务页面组设置面时，控件与字段摆位都从这里取：

```tsx
import {
  IconButton,
  SearchSelect,
  SettingsFieldRow,
  TagInput,
} from "@morlay/dsh-client-ui-primitives/client";

<SettingsFieldRow label="允许的工具" hint="留空 = 不限制" divider layout="inline">
  <TagInput
    value={tools}
    onChange={setTools}
    placeholder="加一个后回车，或粘贴一串"
    label="允许的工具"
    removeLabel={(name) => `移除 ${name}`}
  />
</SettingsFieldRow>;
```

装配：**不是装配行**——client 半随用到它的 client 行内联，`apply` 由那些行各自调用、幂等去重。取舍见
[ADR 基础面暂时内联而不是装配行](./.agents/adrs/20261001-暂时内联而不是装配行.md)。
