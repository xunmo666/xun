# 内部 AI 知识库聊天机器人 — 技术架构

| 字段 | 内容 |
|------|------|
| 文档版本 | v1.0 |
| 最后更新 | 2026-10-16 |
| 关联 PRD | PRD.md v1.0 |
| 技术栈 | Next.js 14 (App Router) + TypeScript + Tailwind CSS + Prisma + Vercel |
| 外部依赖 | Claude API, PostgreSQL, 对象存储(OSS/MinIO) |

---

## 1. 架构图与数据流

### 1.1 整体分层架构

```
┌─────────────────────────────────────────────────────────────┐
│                      客户端（浏览器）                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ 聊天页    │  │ 历史页    │  │ 设置页    │  │ 知识库管理  │  │
│  └─────┬────┘  └─────┬────┘  └─────┬────┘  └──────┬─────┘  │
│        │             │             │              │         │
│        └─────────────┴──────┬──────┴──────────────┘         │
│                             │ SSE / fetch                    │
└─────────────────────────────┼───────────────────────────────┘
                              │
┌─────────────────────────────┼───────────────────────────────┐
│                      Vercel（Next.js）                       │
│                             │                               │
│  ┌──────────────────────────▼───────────────────────────┐   │
│  │                   API Routes 层                       │   │
│  │  /api/auth/*   /api/chat   /api/conversations/*       │   │
│  │  /api/kb/*     /api/messages/*   /api/settings        │   │
│  └──────────────────────────┬───────────────────────────┘   │
│                             │                               │
│  ┌──────────────────────────▼───────────────────────────┐   │
│  │                    Service 层（业务逻辑）              │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────┐ │   │
│  │  │ ChatService│ │ KBService │ │ ConvService│ │UserSvc │ │   │
│  │  └─────┬────┘ └─────┬────┘ └─────┬────┘ └────┬────┘ │   │
│  └────────┼────────────┼────────────┼────────────┼──────┘   │
│           │            │            │            │          │
│  ┌────────▼────────────▼────────────▼────────────▼──────┐   │
│  │              基础设施层（可替换组件）                   │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌───────────────┐ │   │
│  │  │ LLMClient    │ │ Retriever    │ │ DocumentParser│ │   │
│  │  │ (Claude API) │ │ (长上下文/RAG)│ │ (PDF/DOCX/MD)│ │   │
│  │  └──────────────┘ └──────────────┘ └───────────────┘ │   │
│  └──────────────────────────────────────────────────────┘   │
│                             │                               │
└─────────────────────────────┼───────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
┌───────▼───────┐    ┌────────▼────────┐   ┌────────▼────────┐
│  PostgreSQL   │    │  对象存储        │   │   Claude API     │
│ (会话/消息/    │    │ (OSS/MinIO)     │   │  (Anthropic)     │
│  文档/片段)    │    │ (原始文件)       │   │                  │
└───────────────┘    └─────────────────┘   └─────────────────┘
```

### 1.2 核心数据流（提问 → 回答）

```
用户点击发送
    │
    ▼
[1] 前端 fetch POST /api/chat
    │  Body: { conversationId, content, model, useKnowledgeBase }
    │  Header: Authorization (Cookie Session)
    ▼
[2] API Route: /api/chat/route.ts
    │  - 鉴权校验（getServerSession）
    │  - 参数校验（zod）
    │  - 限流检查（Redis/Upstash）
    ▼
[3] ChatService.handleMessage()
    │  ├─ 保存用户消息到 DB
    │  ├─ 加载会话历史（最近 10 轮）
    │  ├─ if (useKnowledgeBase):
    │  │     └─ Retriever.retrieve(query) → Top-K chunks
    │  ├─ 拼接 Prompt（System + 历史 + 检索片段 + 用户问题）
    │  ├─ ModelRouter.select(prompt, useKB) → sonnet / haiku
    │  └─ LLMClient.stream(messages, model)
    ▼
[4] SSE 流式响应
    │  for await (chunk of stream):
    │      res.write(`data: {"type":"token","content":"..."}\n\n`)
    │  结束时:
    │      res.write(`data: {"type":"sources","sources":[...]}\n\n`)
    │      res.write(`data: {"type":"done"}\n\n`)
    ▼
[5] 前端逐 token 渲染
    │  - token 到达 → 追加到文本节点（轻量）
    │  - 节流 100ms → Markdown 全量解析
    │  - done 事件 → 展示来源卡片
    ▼
[6] 后端 finally 块（与流式解耦）
    ├─ 保存 AI 消息（来源列表 + token 统计，不存全文）
    ├─ 记录 RequestLog（脱敏）
    └─ 更新会话 updated_at
```

### 1.3 知识库上传数据流

```
用户上传文档
    │
    ▼
[1] POST /api/kb/upload (multipart/form-data)
    │  - 鉴权 + 角色校验（kb_admin 及以上）
    │  - 文件校验（类型/大小 ≤ 50MB）
    ▼
[2] KBService.uploadDocument()
    │  ├─ 保存原始文件到对象存储
    │  ├─ 创建 KnowledgeDocument 记录（status=parsing）
    │  └─ 触发异步解析（Serverless Function / 队列）
    ▼
[3] DocumentParser.parse()
    │  ├─ 文本抽取（PDF→pdf-parse, DOCX→mammoth, MD/TXT→直接读）
    │  ├─ 结构切分（按标题层级/页码/段落，chunk_size=1200, overlap=200）
    │  ├─ 写入 DocumentChunk 表
    │  └─ 更新 KnowledgeDocument（status=ready, chunk_count=N）
    ▼
[4] 前端轮询 /api/kb/documents/:id 获取状态
```

---

## 2. Next.js 目录结构

```
ai-kb-chat/
├── app/                          # App Router
│   ├── (auth)/                   # 认证路由组（无布局）
│   │   └── login/page.tsx        # 登录页（SSO 跳转）
│   │
│   ├── (app)/                    # 需登录的路由组
│   │   ├── layout.tsx            # 主布局（侧边栏 + 顶部栏）
│   │   ├── chat/page.tsx         # 聊天页
│   │   ├── history/page.tsx      # 历史页
│   │   ├── settings/page.tsx     # 设置页
│   │   └── kb/                   # 知识库管理（P1，角色守卫）
│   │       ├── page.tsx          # 文档列表
│   │       └── upload/page.tsx   # 上传页
│   │
│   ├── api/                      # API Routes
│   │   ├── auth/                 # Auth.js 配置
│   │   │   └── [...nextauth]/route.ts
│   │   ├── chat/
│   │   │   └── route.ts          # POST: 流式对话
│   │   ├── conversations/
│   │   │   ├── route.ts          # GET 列表 / POST 新建
│   │   │   └── [id]/
│   │   │       ├── route.ts      # GET 详情 / DELETE 删除
│   │   │       └── messages/
│   │   │           └── route.ts  # GET 消息列表
│   │   ├── kb/
│   │   │   ├── documents/
│   │   │   │   ├── route.ts      # GET 列表
│   │   │   │   └── [id]/route.ts # GET 详情 / DELETE
│   │   │   ├── upload/route.ts   # POST 上传
│   │   │   └── parse/route.ts    # POST 触发解析（内部）
│   │   ├── settings/
│   │   │   └── route.ts          # GET / PATCH 用户偏好
│   │   └── feedback/
│   │       └── route.ts          # POST 答案反馈
│   │
│   ├── globals.css               # Tailwind + 全局样式
│   └── layout.tsx                # 根布局
│
├── components/                   # 可复用 UI 组件
│   ├── chat/
│   │   ├── MessageList.tsx       # 消息列表
│   │   ├── MessageItem.tsx       # 单条消息（含流式渲染）
│   │   ├── StreamingMarkdown.tsx # 流式 Markdown 渲染
│   │   ├── SourceList.tsx        # 来源卡片列表
│   │   ├── InputArea.tsx         # 输入区
│   │   └── ModelSwitcher.tsx     # 模型切换器
│   ├── sidebar/
│   │   ├── Sidebar.tsx           # 侧边栏
│   │   └── ConversationItem.tsx  # 会话列表项
│   ├── common/
│   │   ├── Avatar.tsx
│   │   ├── EmptyState.tsx
│   │   ├── ErrorState.tsx
│   │   └── Skeleton.tsx
│   └── layout/
│       └── AppLayout.tsx         # 主布局壳
│
├── lib/                          # 业务逻辑（Service 层）
│   ├── services/
│   │   ├── chat.service.ts       # 对话业务编排
│   │   ├── conversation.service.ts
│   │   ├── kb.service.ts         # 知识库业务
│   │   └── user.service.ts
│   ├── llm/
│   │   ├── client.ts             # Claude API 封装（统一接口）
│   │   ├── router.ts             # 模型路由策略
│   │   └── prompts.ts            # Prompt 模板
│   ├── knowledge/
│   │   ├── retriever.ts          # 检索抽象接口
│   │   ├── long-context.retriever.ts  # 长上下文实现
│   │   ├── rag.retriever.ts      # RAG 实现（P2）
│   │   ├── parser.ts             # 文档解析
│   │   └── chunker.ts            # 文档切分
│   ├── auth/
│   │   └── auth.ts               # Auth.js 配置
│   ├── db/
│   │   └── prisma.ts             # Prisma Client 单例
│   ├── storage/
│   │   └── oss.ts                # 对象存储封装
│   ├── middleware/
│   │   ├── rate-limit.ts         # 限流
│   │   └── audit.ts              # 审计日志
│   └── utils/
│       ├── sse.ts                # SSE 响应辅助
│       ├── sanitize.ts           # 输入/日志脱敏
│       └── errors.ts             # 统一错误处理
│
├── prisma/
│   ├── schema.prisma             # 数据模型
│   └── migrations/               # 数据库迁移
│
├── middleware.ts                 # 全局中间件（鉴权/限流/IP 白名单）
├── .env.local                    # 环境变量（不入库）
├── .env.example                  # 环境变量示例
├── next.config.mjs
├── tailwind.config.ts
├── tsconfig.json
└── package.json
```

**分层原则**：
- `app/api/*`：只做协议层（鉴权、参数校验、调用 Service、组装响应），不写业务逻辑
- `lib/services/*`：业务编排层，调用基础设施层
- `lib/llm/*`、`lib/knowledge/*`：可替换基础设施，通过接口隔离
- `components/*`：纯 UI，不直接调用 API，通过 props 接收数据

---

## 3. API 契约

### 3.1 `POST /api/chat` — 流式对话

**入参（JSON Body）**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `conversationId` | string | 否 | 会话 ID，不传则新建 |
| `content` | string | 是 | 用户消息内容，1~2000 字 |
| `model` | string | 否 | `auto` / `sonnet` / `haiku`，默认 `auto` |
| `useKnowledgeBase` | boolean | 否 | 是否检索知识库，默认 `true` |

**请求示例**

```json
{
  "conversationId": "conv_abc123",
  "content": "公司年假政策是什么？",
  "model": "auto",
  "useKnowledgeBase": true
}
```

**出参（SSE 流，Content-Type: text/event-stream）**

事件类型：

| type | 字段 | 说明 |
|------|------|------|
| `token` | `content: string` | 增量文本片段 |
| `sources` | `sources: Source[]` | 引用来源列表（done 前发送） |
| `done` | - | 流结束 |
| `error` | `code: string, message: string` | 错误 |

**Source 结构**

```json
{
  "docId": "doc_xxx",
  "docTitle": "员工手册_v3.2.pdf",
  "sectionPath": "考勤 > 年假",
  "snippet": "正式员工享有5天年假..."
}
```

**SSE 响应示例**

```
data: {"type":"token","content":"根据"}

data: {"type":"token","content":"公司"}

data: {"type":"token","content":"政策，"}

...

data: {"type":"sources","sources":[{"docId":"doc_001","docTitle":"员工手册_v3.2.pdf","sectionPath":"考勤 > 年假","snippet":"正式员工享有5天年假..."}]}

data: {"type":"done"}
```

**错误码**

| HTTP 状态 | code | message | 触发场景 |
|-----------|------|---------|---------|
| 400 | `INVALID_CONTENT` | 消息内容不能为空或超出长度限制 | content 为空或 >2000 字 |
| 400 | `INVALID_MODEL` | 不支持的模型类型 | model 非 auto/sonnet/haiku |
| 401 | `UNAUTHORIZED` | 未登录 | 无有效 Session |
| 403 | `FORBIDDEN` | 无权限访问 | 角色不足 |
| 429 | `RATE_LIMITED` | 请求过于频繁，请稍后重试 | 超过 60 次/分钟 |
| 500 | `LLM_TIMEOUT` | 模型响应超时 | Claude API >30s 无响应 |
| 500 | `LLM_RATE_LIMITED` | 模型服务繁忙，请稍后重试 | Claude 返回 429 |
| 500 | `KB_RETRIEVE_ERROR` | 知识库检索失败 | 检索服务异常 |
| 500 | `INTERNAL_ERROR` | 服务器内部错误 | 未预期异常 |

**错误响应格式（非流式，JSON）**

```json
{
  "error": {
    "code": "LLM_TIMEOUT",
    "message": "模型响应超时"
  }
}
```

### 3.2 `GET /api/conversations` — 会话列表

**入参（Query）**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `page` | number | 否 | 页码，默认 1 |
| `pageSize` | number | 否 | 每页条数，默认 20 |
| `keyword` | string | 否 | 搜索关键词（标题/内容） |

**出参**

```json
{
  "data": [
    {
      "id": "conv_xxx",
      "title": "公司年假政策是什么？",
      "model": "sonnet",
      "updatedAt": "2026-10-16T10:00:00Z"
    }
  ],
  "total": 42,
  "page": 1,
  "pageSize": 20
}
```

### 3.3 `POST /api/kb/upload` — 上传文档

**入参（multipart/form-data）**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file` | File | 是 | PDF/DOCX/MD/TXT，≤ 50MB |
| `category` | string | 否 | 分类标签 |

**出参**

```json
{
  "id": "doc_xxx",
  "title": "员工手册.pdf",
  "status": "parsing"
}
```

### 3.4 `GET /api/kb/documents/:id` — 文档状态

**出参**

```json
{
  "id": "doc_xxx",
  "title": "员工手册.pdf",
  "status": "ready",
  "chunkCount": 156,
  "category": "HR",
  "createdAt": "2026-10-16T09:00:00Z"
}
```

---

## 4. 环境变量清单

### 4.1 必需变量

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `ANTHROPIC_API_KEY` | Claude API Key | `sk-ant-xxx` |
| `DATABASE_URL` | PostgreSQL 连接串 | `postgresql://user:pass@host:5432/db` |
| `NEXTAUTH_SECRET` | Auth.js 加密密钥 | `openssl rand -base64 32` |
| `NEXTAUTH_URL` | 站点 URL | `https://kb.company.com` |
| `SSO_ISSUER` | OIDC Issuer | `https://sso.company.com` |
| `SSO_CLIENT_ID` | OIDC Client ID | `ai-kb-chat` |
| `SSO_CLIENT_SECRET` | OIDC Client Secret | `xxx` |
| `OSS_ENDPOINT` | 对象存储端点 | `https://oss-cn-hangzhou.aliyuncs.com` |
| `OSS_BUCKET` | 存储桶名 | `company-kb-docs` |
| `OSS_ACCESS_KEY_ID` | OSS 密钥 ID | `xxx` |
| `OSS_ACCESS_KEY_SECRET` | OSS 密钥 | `xxx` |

### 4.2 可选变量（有默认值）

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| `CLAUDE_MODEL_SONNET` | Sonnet 模型名 | `claude-sonnet-4-20250514` |
| `CLAUDE_MODEL_HAIKU` | Haiku 模型名 | `claude-haiku-4-20250514` |
| `CLAUDE_MAX_TOKENS` | 最大输出 token | `4096` |
| `CLAUDE_TIMEOUT_MS` | 超时时间 | `30000` |
| `KB_TOP_K` | 检索返回片段数 | `8` |
| `KB_CHUNK_SIZE` | 切分大小（字符） | `1200` |
| `KB_CHUNK_OVERLAP` | 切分重叠（字符） | `200` |
| `RATE_LIMIT_PER_MINUTE` | 单用户每分钟请求上限 | `60` |
| `MAX_HISTORY_ROUNDS` | 上下文保留轮数 | `10` |
| `MAX_CONTENT_LENGTH` | 单条消息最大字数 | `2000` |
| `IP_WHITELIST` | IP 白名单（逗号分隔） | ``（空=不限制） |
| `LOG_LEVEL` | 日志级别 | `info` |

### 4.3 环境变量加载策略

- **本地开发**：`.env.local`（gitignore）
- **Vercel 部署**：Vercel Dashboard 环境变量
- **敏感变量**（API Key、Secret）：仅服务端可访问，不在客户端暴露
- **校验**：启动时用 `zod` 校验必需变量，缺失则启动失败并提示

```typescript
// lib/config.ts
import { z } from 'zod';

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  NEXTAUTH_SECRET: z.string().min(1),
  // ...
});

export const env = envSchema.parse(process.env);
```

---

## 5. Claude 模型路由策略

### 5.1 路由决策矩阵

| 条件 | 模型 | 优先级 |
|------|------|--------|
| 用户显式选择 `sonnet` | Sonnet | 最高（用户意愿优先） |
| 用户显式选择 `haiku` | Haiku | 最高 |
| `useKnowledgeBase === true` | **Sonnet** | 高（知识问答需长上下文理解 + 精确引用） |
| 问题包含代码关键词（`代码`/`函数`/`SQL`/`bug`/`报错`/`class`/`def`） | **Sonnet** | 高 |
| 文档总结模式（输入含长文档） | **Sonnet** | 高 |
| 问题长度 < 50 字 **且** 无知识库检索 | **Haiku** | 中 |
| 翻译/润色/写作类（含关键词：`翻译`/`润色`/`写一封`/`帮我写`） | **Haiku** | 中 |
| 其他（默认兜底） | **Haiku** | 低 |

### 5.2 路由实现（规则引擎）

```typescript
// lib/llm/router.ts
import { env } from '@/lib/config';

type ModelPreference = 'auto' | 'sonnet' | 'haiku';

const CODE_KEYWORDS = ['代码', '函数', 'sql', 'bug', '报错', 'class', 'def', '接口', 'api'];
const SIMPLE_KEYWORDS = ['翻译', '润色', '写一封', '帮我写', '转成', '缩写'];

export function selectModel(
  content: string,
  useKnowledgeBase: boolean,
  preference: ModelPreference
): string {
  // 1. 用户显式选择优先
  if (preference === 'sonnet') return env.CLAUDE_MODEL_SONNET;
  if (preference === 'haiku') return env.CLAUDE_MODEL_HAIKU;

  // 2. 知识库检索 → Sonnet
  if (useKnowledgeBase) return env.CLAUDE_MODEL_SONNET;

  // 3. 代码相关 → Sonnet
  if (CODE_KEYWORDS.some(k => content.toLowerCase().includes(k))) {
    return env.CLAUDE_MODEL_SONNET;
  }

  // 4. 短问题 + 简单任务 → Haiku
  if (content.length < 50 || SIMPLE_KEYWORDS.some(k => content.includes(k))) {
    return env.CLAUDE_MODEL_HAIKU;
  }

  // 5. 默认 Haiku
  return env.CLAUDE_MODEL_HAIKU;
}
```

### 5.3 MVP 与 P1 演进

- **MVP**：全部走 Sonnet，`selectModel` 直接返回 Sonnet，先跑通链路
- **P1**：启用上述规则路由，降低成本

### 5.4 成本对比参考

| 模型 | 输入单价 | 输出单价 | 适用场景 |
|------|---------|---------|---------|
| Sonnet 4 | $3 / M tokens | $15 / M tokens | 知识问答、代码、复杂推理 |
| Haiku 4 | $0.25 / M tokens | $1.25 / M tokens | 日常问答、翻译、写作 |

Haiku 成本约为 Sonnet 的 **1/12**，合理路由可节省 60%+ API 成本。

---

## 6. 知识库方案：长上下文 vs RAG

### 6.1 方案对比

| 维度 | 长上下文（当前） | RAG（P2 演进） |
|------|-----------------|---------------|
| 原理 | 检索 Top-K 片段直接拼入 prompt | 向量召回 + 重排序 |
| 知识库规模 | ≤ 500 篇 / ≤ 50 万字 | 无上限 |
| 检索精度 | 中（BM25 + 简单重排序） | 高（语义向量 + 重排序） |
| 实现复杂度 | 低 | 中（需向量数据库 + embedding） |
| 延迟 | 低（< 500ms） | 中（500~800ms，含向量查询） |
| 成本 | 高（输入 token 多） | 低（只传相关片段） |
| 可解释性 | 高（直接看到传入内容） | 中（向量召回黑盒） |

### 6.2 长上下文 → RAG 切换判断标准

满足以下 **任一条件** 时，启动 RAG 升级：

| 指标 | 阈值 | 说明 |
|------|------|------|
| 知识库文档数 | > 500 篇 | 长上下文召回精度下降 |
| 知识库总字数 | > 50 万字 | Top-K 拼接后 prompt 接近上限 |
| 单次问答输入 token | > 80K | 接近 Sonnet 200K 上下文上限的 40% |
| 知识问答准确率 | < 80% | BM25 召回无法满足 |
| 用户反馈"找不到答案" | 月均 > 50 次 | 召回不足的强信号 |

### 6.3 检索层抽象（可平滑切换）

```typescript
// lib/knowledge/retriever.ts
export interface Retriever {
  retrieve(query: string, options?: { topK?: number }): Promise<Chunk[]>;
}

export interface Chunk {
  docId: string;
  docTitle: string;
  sectionPath: string;
  content: string;
  score: number;
}

// 长上下文实现
export class LongContextRetriever implements Retriever {
  async retrieve(query: string, options = {}) {
    // BM25 召回 Top-20 → 语义重排序 → Top-K
  }
}

// RAG 实现（P2）
export class RagRetriever implements Retriever {
  async retrieve(query: string, options = {}) {
    // 向量召回 → 重排序 → Top-K
  }
}

// 工厂：根据配置选择实现
export function createRetriever(): Retriever {
  return process.env.KB_MODE === 'rag' ? new RagRetriever() : new LongContextRetriever();
}
```

**关键设计**：`ChatService` 只依赖 `Retriever` 接口，切换方案只需改环境变量 `KB_MODE`，上层业务代码零改动。

---

## 7. 成本控制策略

### 7.1 成本结构（基准：500 人，40% 周活跃）

| 项 | 月成本 | 占比 |
|----|-------|------|
| Claude API | ~$210 | 80% |
| Vercel | $0~50 | 15% |
| 数据库 + OSS | $50~100 | 5% |
| **合计** | **~$260~360** | 100% |

### 7.2 七层成本控制

#### 第 1 层：模型路由（P1，节省 60% API 成本）

日常问答走 Haiku（1/12 价格），仅知识问答/代码走 Sonnet。

#### 第 2 层：检索 Top-K 限制

- 默认 `KB_TOP_K=8`，而非 20
- 输入 token 减少 60%
- 可通过环境变量动态调整

#### 第 3 层：上下文截断

```typescript
// 只保留最近 MAX_HISTORY_ROUNDS 轮，超出用摘要替代
const history = await convService.getHistory(conversationId, {
  maxRounds: env.MAX_HISTORY_ROUNDS, // 默认 10
});
```

#### 第 4 层：请求限流

- 单用户 60 次/分钟
- 全局限流 1000 次/分钟
- 防止滥用和意外刷量

#### 第 5 层：输出 token 控制

- `CLAUDE_MAX_TOKENS=4096`
- 知识问答场景可降至 2048（答案通常较短）
- System Prompt 约束"简洁回答，不超过 500 字"

#### 第 6 层：缓存（P2）

- 相似问题（embedding 相似度 > 0.95）直接返回缓存答案
- 内部知识问答重复性高，缓存命中率预计 30%+

#### 第 7 层：成本监控告警

| 告警项 | 阈值 | 动作 |
|--------|------|------|
| 日 API 成本 | > $15 | 通知管理员 |
| 单用户日请求 | > 200 次 | 限流 + 审计 |
| 单请求 token | > 100K | 告警 + 截断 |

### 7.3 成本计算公式

```
日 API 成本 = Σ(每模型请求数 × (输入token × 输入单价 + 输出token × 输出单价))

月成本估算：
  知识问答(Sonnet): 960次/日 × (4000×$3 + 800×$15) / 1M = $187/月
  日常问答(Haiku):  640次/日 × (1000×$0.25 + 600×$1.25) / 1M = $23/月
  合计: $210/月
```

---

## 8. 安全策略

### 8.1 API Key 管理

| 项 | 措施 |
|----|------|
| 存储 | 仅存于 Vercel 环境变量 / `.env.local`，**不入库、不写代码** |
| 访问范围 | 服务端 API Routes 可访问，客户端代码无法获取 |
| 轮换 | 每 90 天轮换一次，通过 Vercel API 自动化 |
| 泄露响应 | 接入 Anthropic API Key 泄露检测，发现异常立即吊销 |
| 日志脱敏 | 日志中 API Key 一律替换为 `***` |

```typescript
// lib/llm/client.ts
import Anthropic from '@anthropic-ai/sdk';

// 仅在服务端实例化
const anthropic = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY, // 从环境变量读取
});
```

### 8.2 访问控制

#### 8.2.1 认证

- **协议**：OIDC 2.0，对接企业 IdP
- **框架**：Auth.js (next-auth)
- **Session**：JWT + HttpOnly + Secure + SameSite=Lax Cookie
- **过期**：Access Token 1 小时，Refresh Token 7 天，静默刷新

```typescript
// middleware.ts — 全局鉴权
import { withAuth } from 'next-auth/middleware';

export default withAuth({
  pages: { signIn: '/login' },
});

// 仅保护需登录的页面
export const config = {
  matcher: ['/chat/:path*', '/history/:path*', '/settings/:path*', '/api/:path*'],
};
```

#### 8.2.2 授权（RBAC）

```typescript
// lib/middleware/rbac.ts
export function requireRole(role: UserRole) {
  return (handler) => async (req) => {
    const session = await getServerSession();
    if (!session) return unauthorized();
    if (session.user.role !== role && session.user.role !== 'sys_admin') {
      return forbidden();
    }
    return handler(req);
  };
}
```

| 角色 | /api/chat | /api/kb/upload | /api/kb/documents/:id DELETE | 用户管理 |
|------|-----------|----------------|------------------------------|---------|
| employee | ✅ | ❌ | ❌ | ❌ |
| kb_admin | ✅ | ✅ | ✅ | ❌ |
| sys_admin | ✅ | ✅ | ✅ | ✅ |

#### 8.2.3 数据隔离

- 会话查询强制 `WHERE user_id = ?`，通过 Prisma 中间件统一注入
- 知识库文档默认全员可见（MVP），P2 支持按 `category` + 部门细粒度控制
- 所有写操作校验 `user_id` 归属，防止越权

#### 8.2.4 网络访问控制

- Vercel 部署后配置 **IP 白名单**（仅企业内网/VPN 出口 IP）
- 或前置 **企业 API 网关** 做统一鉴权
- `middleware.ts` 中校验客户端 IP

```typescript
// middleware.ts
const WHITELIST = (env.IP_WHITELIST || '').split(',');

if (WHITELIST.length > 0) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0];
  if (!WHITELIST.includes(ip)) {
    return new Response('Forbidden', { status: 403 });
  }
}
```

### 8.3 日志脱敏

#### 8.3.1 脱敏规则

| 数据类型 | 处理方式 |
|---------|---------|
| API Key / Secret | 全部替换为 `***` |
| 用户密码 | 不记录 |
| 身份证号 | 保留前 3 后 4，中间 `*` |
| 手机号 | 保留前 3 后 4，中间 `*` |
| 邮箱 | 用户名前 2 字符 + `***@` + 域名 |
| AI 回答全文 | **不记录**（仅存来源 + token 统计） |
| 用户问题 | 敏感词替换后记录（用于统计，不存原文） |

#### 8.3.2 脱敏实现

```typescript
// lib/utils/sanitize.ts
export function sanitizeLog(input: string): string {
  return input
    .replace(/sk-[a-zA-Z0-9-]{20,}/g, '***')                    // API Key
    .replace(/1[3-9]\d{9}/g, (m) => m.slice(0,3) + '****' + m.slice(7))  // 手机号
    .replace(/\d{17}[\dXx]/g, (m) => m.slice(0,3) + '***********' + m.slice(14))  // 身份证
    .replace(/([a-zA-Z0-9]{2})[a-zA-Z0-9._-]*@/g, '$1***@');  // 邮箱
}

// 使用
console.log(sanitizeLog(`用户 ${user.email} 提问: ${content}`));
```

#### 8.3.3 日志分级

| 级别 | 内容 | 保留期 |
|------|------|--------|
| `error` | 异常堆栈、错误码 | 180 天 |
| `warn` | 限流、降级、重试 | 90 天 |
| `info` | 请求摘要（用户ID、模型、token数、耗时） | 90 天 |
| `debug` | 详细流程（仅开发环境） | 开发环境，不持久化 |

### 8.4 内容安全

| 项 | 措施 |
|----|------|
| Prompt 注入防护 | System Prompt 与用户输入物理分离（messages 数组不同 role）；用户输入用 `<user_input>` 标签包裹 |
| 敏感词过滤 | 用户输入和模型输出均过企业敏感词库，命中则拦截或替换 |
| 输出审查 | 对回答做敏感信息二次扫描（正则 + 关键词） |
| 审计追踪 | 所有 API 调用记录 `user_id` + `timestamp` + `action`，仅 sys_admin 可查 |

---

## 9. 部署架构

```
                    ┌──────────────┐
企业内网/VPN ──────▶│  企业网关     │
                    │ (IP白名单/SSO)│
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │   Vercel     │
                    │  (Next.js)   │
                    └──┬──────┬────┘
                       │      │
              ┌────────▼──┐ ┌─▼───────────┐
              │ PostgreSQL │ │  对象存储    │
              │ (Neon/自建) │ │ (OSS/MinIO) │
              └────────────┘ └─────────────┘
                       │
              ┌────────▼────────┐
              │   Claude API    │
              │  (Anthropic)    │
              └─────────────────┘
```

**部署选择**：
- **计算**：Vercel（Next.js 原生支持，Edge Functions 低延迟）
- **数据库**：Neon PostgreSQL（Serverless，Vercel 集成）或自建 PostgreSQL
- **对象存储**：阿里云 OSS / 自建 MinIO（文档原文）
- **外部 API**：Claude API（直连，无需代理）

---

## 附录 A：关键技术决策记录（ADR）

| ADR | 决策 | 理由 |
|-----|------|------|
| ADR-001 | 知识库 MVP 用长上下文而非 RAG | 文档量小，实现简单，准确率可接受 |
| ADR-002 | 检索层抽象为接口 | 长上下文 → RAG 平滑切换，上层零改动 |
| ADR-003 | AI 回答全文不持久化 | 降低敏感信息留存风险，符合内部合规 |
| ADR-004 | 模型路由用规则引擎而非 LLM 分类 | 零延迟、零额外成本，准确率足够 |
| ADR-005 | 流式渲染分层（token 追加 + 节流 Markdown） | 避免块状闪烁，提升体验 |
| ADR-006 | Prisma 作为 ORM | 类型安全，迁移管理成熟，Next.js 生态首选 |

---

*本文档为技术实现依据。架构变更需更新 ADR 并通知开发团队。*
