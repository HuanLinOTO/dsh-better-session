# LLM 适配

为 DeepSeek Harness 提供 **OpenAI 兼容 LLM 适配器**插件的领域：把 harness
消息转换为 AI SDK prompt、合并采样默认参数、翻译 stream part、归一化错误
与凭据策略。

边界：只覆盖 `llm/llm-openai-compatible` 一个包（不碰 LLM 路由的消费方与其它 provider 适配器）；
边界表在仓库根 [`.agents/GLOSSARY-MAP.md`](../../../../.agents/GLOSSARY-MAP.md)。

### 配置与路由

**provider 路由（provider route）**：
`providers` dict 的 key——选择器与 `GenerateOptions.provider` 使用的路由键，
值是 profile。
_避免使用_：provider 名、路由名

**profile**：
单个 provider 路由的完整配置：凭据引用、baseURL、采样默认参数、模型目录、
传输参数与重试策略。
本表的 `profile` **只指这个配置段**——不是 `$DSH_HOME/profiles/<name>` 那个装配根（那是 `profileDir`），
也不是 `client/ui-primitives` 说的「一行 config 的 profile 行」。
_避免使用_：配置块、provider 配置

**采样默认参数（sampling defaults）**：
profile 级默认采样参数（`temperature` / `topP` / `topK` /
`presencePenalty` / `frequencyPenalty` / `seed`）——请求级
`GenerateOptions.temperature` 优先于 profile 默认值。
_避免使用_：采样配置、默认采样

**模型目录（model catalog）**：
profile 内 `models` 列表——声明模型能力（contextWindow / maxTokens /
inputModalities / reasoningEfforts）；缺省与未列出 id 的行为见
[ADR-模型目录缺省为空且描述模型绝不抛错](./adrs/20260917-模型目录缺省为空且描述模型绝不抛错.md)。
_避免使用_：模型列表、模型注册表

**reasoning 档位（reasoning effort）**：
`off` / `low` / `high` / `max` 四档——同一套取值写在 profile 的 `reasoning`、
模型的 `reasoningEfforts` 与 wire 的 `reasoning_effort` 三处，`off` = 不发送
该字段（映射与省略语义见
[ADR-采样默认值合并规则与省略语义](./adrs/20260917-采样默认值合并规则与省略语义.md)）。
_避免使用_：推理级别、思考档位

### 请求与传输

**wire 字段**：
发送到 OpenAI 兼容端点的请求体字段（`temperature` / `max_tokens` /
`top_p` / `reasoning_effort` 等）——采样默认值合并的落点。
_避免使用_：请求字段、传输字段

**stream part**：
AI SDK 流式响应单元——本插件翻译为 harness `StreamChunk`。
_避免使用_：流块、chunk

**流空闲超时（stream idle timeout）**：
传输参数 `streamIdleTimeoutMs` 的语义——一段时间没有新事件就判超时；与整体
请求超时（`timeoutMs`）互为独立的两个参数（行为见
[ADR-传输层复用ai-sdk-openai-compatible而非自研wire序列化](./adrs/20260917-传输层复用ai-sdk-openai-compatible而非自研wire序列化.md)）。
_避免使用_：空闲超时、流超时

**错误归一化（error normalization）**：
HTTP 状态 + 错误体 → harness `LlmError` 码（映射表见
[ADR-传输层复用ai-sdk-openai-compatible而非自研wire序列化](./adrs/20260917-传输层复用ai-sdk-openai-compatible而非自研wire序列化.md)）。
_避免使用_：错误映射、错误翻译

**凭据策略（credential policy）**：
profile 用 `apiKeyEnv` 声明凭据来源；不设置即表达**无认证端点**（请求不带
`authorization` 头，如本地 Ollama）。解析、回退与缺失行为见
[ADR-凭据经credentials服务解析而非直接读环境变量](./adrs/20260917-凭据经credentials服务解析而非直接读环境变量.md)。
_避免使用_：认证方式、密钥解析

**cacheReadTokens**：
`prompt_tokens_details.cached_tokens` 与 DeepSeek 方言的
`prompt_cache_hit_tokens` 拆出的缓存读取 token（disjoint 计数）。
_避免使用_：缓存 token、命中 token
