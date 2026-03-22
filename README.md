# Cursor2API

将 Cursor 免费 AI 对话接口代理转换为 **Anthropic Messages API** 和 **OpenAI Chat Completions API**，支持 **Claude Code** 和 **Cursor IDE** 使用。

## 原理

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│ Claude Code  │────▶│              │────▶│              │
│ (Anthropic)  │     │  cursor2api  │     │  Cursor API  │
│              │◀────│  (代理+转换)  │◀────│  /api/chat   │
└─────────────┘     └──────────────┘     └──────────────┘
       ▲                    ▲
       │                    │
┌──────┴──────┐     ┌──────┴──────┐
│  Cursor IDE  │     │ OpenAI 兼容  │
│(/v1/responses│     │(/v1/chat/   │
│ + Agent模式) │     │ completions)│
└─────────────┘     └─────────────┘
```

## 核心特性

- **Anthropic Messages API 完整兼容** — `/v1/messages` 流式/非流式，直接对接 Claude Code
- **OpenAI Chat Completions API 兼容** — `/v1/chat/completions`，对接 ChatBox / LobeChat 等客户端
- **Cursor IDE Agent 模式适配** — `/v1/responses` 端点 + 扁平工具格式 + 增量流式工具调用
- **Web 管理面板** — 浏览器访问 `/admin/` 可视化编辑配置，保存时自动同步 `.env.docker`
- **工具参数自动修复** — 字段名映射、智能引号替换、模糊匹配修复（`tool-fixer.ts`）
- **多模态视觉降级处理** — 内置纯本地 CPU OCR（零配置免 Key），或外接第三方视觉大模型 API
- **多层拒绝拦截** — 50+ 正则模式检测拒绝，普通重试 + 提示词注入强制重试
- **四层身份保护** — 身份探针识别 + 拒绝重试 + 提示词注入重试 + 响应清洗
- **项目理解意图检测** — 用户询问项目结构/架构时自动注入强制本地文件检查指令
- **代理订阅自动导入** — 订阅 URL 自动拉取 HTTP/HTTPS/SOCKS 代理，支持定时刷新
- **机场订阅桥接** — 通过本地 Mihomo 内核消费 vmess/vless/trojan/ss 等机场订阅
- **上下文智能压缩** — 长对话老消息自动压缩（非丢弃），保留因果链语义，压缩率 70-80%
- **截断自动续写** — 检测未闭合代码块/XML，返回 `max_tokens` 让 Claude Code 自动继续
- **请求队列管理** — 可配置并发数、队列超时与状态日志
- **Chrome TLS 指纹** — 模拟真实浏览器请求头
- **SSE 流式传输** — 实时响应，工具参数 128 字节增量分块
- **连续同角色消息自动合并** — 满足 Anthropic API 交替要求，解决 Cursor IDE 格式兼容问题
- **上下文清洗** — 自动清理历史对话中的权限拒绝和错误记忆

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动（开发模式）

```bash
npm run dev
```

### 3. 配合 Claude Code 使用

```bash
export ANTHROPIC_BASE_URL=http://localhost:3010
claude
```

### 4. 配合 Cursor IDE 使用

在 Cursor IDE 的设置中配置：
```
OPENAI_BASE_URL=http://localhost:3010/v1
```
模型选择 `claude-sonnet-4-20250514` 或其他 Claude 模型名（通过 `/v1/models` 查看）。

> ⚠️ Cursor IDE 请优先选用 Claude 模型名，避免使用 GPT 模型名以获得最佳兼容。

### 5. Web 管理面板

启动后浏览器访问 `http://localhost:3010/admin/` 可视化编辑所有配置。根路径浏览器请求自动重定向至 `/admin/`。

## 配置说明

编辑 `config.yaml`（或通过 Web 管理面板），以下为主要配置项：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `cursor_model` | 使用的模型 | `anthropic/claude-sonnet-4.6` |
| `port` | 监听端口 | `3010` |
| `timeout` | 请求超时（秒） | `120` |
| `concurrency` | 最大并发数 | — |
| `queue_timeout` | 队列等待超时（毫秒） | — |
| `retry_delay` | 429 初始退避（毫秒） | — |
| `max_retry_delay` | 429 退避上限（毫秒） | — |
| `enable_thinking` | 启用 Thinking 提取与透传 | `false` |
| `system_prompt_inject` | 追加到每个请求的系统提示词 | — |
| `proxy` | 单代理地址 | — |
| `proxy_pool` | 静态代理地址列表 | — |
| `proxy_subscriptions` | 代理订阅 URL 列表，自动拉取刷新 | — |
| `airport_subscriptions` | 机场订阅列表（Mihomo 桥接） | — |
| `airport_runtime_mode` | 机场桥接模式：`auto` / `combined` / `per-subscription` | `auto` |
| `airport_runtime_group_type` | Mihomo 策略组：`url-test` / `load-balance` | `url-test` |
| `vision.enabled` | 开启图片视觉降级处理 | `false` |
| `vision.mode` | 视觉模式：`ocr`（本地）/ `api`（外接） | `ocr` |
| `fingerprint.user_agent` | 模拟浏览器 User-Agent | Chrome 140 |

**配置优先级**：`环境变量` > `config.yaml` > 默认值

Docker 部署时环境变量统一来自 `.env.docker`，Web 管理面板保存时两份文件自动同步。

## Docker 部署

```bash
docker compose up -d --build
```

默认启动两个等价实例：
- `cursor2api` → `http://localhost:3010`
- `cursor2api-2` → `http://localhost:3011`

只需一个实例：

```bash
docker compose up -d --build cursor2api
```

调整宿主机端口：

```bash
export HOST_PORT_1=4010 HOST_PORT_2=4011
docker compose up -d --build
```

代码变更后重新构建：

```bash
docker compose up -d --build --force-recreate --remove-orphans
# 或
npm run docker:deploy
```

**部署说明：**
- `docker compose restart` — 让容器重新读取已修改的 `config.yaml`（无需重建镜像）
- `src/` / `package.json` / `tsconfig.json` 变更 — 必须重新 build + recreate
- `.env.docker` 变更 — 执行 `docker compose up -d --force-recreate`
- Web 管理面板保存 — 自动写入 `config.yaml`，挂载了 `ADMIN_ENV_FILE_PATH` 时同步更新 `.env.docker`
- 容器内监听端口固定为 `3010`，调整对外端口请修改 `HOST_PORT_1` / `HOST_PORT_2`

当前 Docker 镜像已内置 `mihomo`，配置 `airport_subscriptions` 后无需额外挂载二进制。

**代理订阅接口：**

```bash
curl http://localhost:3010/v1/proxy/subscriptions
curl -X POST http://localhost:3010/v1/proxy/subscriptions/reload
curl http://localhost:3010/v1/airport/runtime
```

> 默认仅本机回环地址可访问；需远程访问请开启 `proxy_subscription_api_enabled` 并配置 `proxy_subscription_api_token`。

## 项目结构

```
cursor2api/
├── src/
│   ├── index.ts              # 入口 + Express 服务 + 路由（根路径重定向 /admin/）
│   ├── config.ts             # 配置管理（CONFIG_YAML_PATH / createDefaultConfig / isTruthyEnvValue）
│   ├── admin-config.ts       # Web 管理面板接口 + .env.docker 双向同步
│   ├── handler.ts            # Anthropic API 处理器 + 拒绝拦截 + 身份保护
│   ├── openai-handler.ts     # OpenAI / Cursor IDE 兼容处理器
│   ├── converter.ts          # 协议转换 + 提示词注入 + 项目意图检测 + 上下文清洗
│   ├── cursor-client.ts      # Cursor API 客户端 + Chrome TLS 指纹
│   ├── cursor-usage.ts       # 真实 Token 用量透传
│   ├── tool-fixer.ts         # 工具参数自动修复
│   ├── tool-metadata.ts      # 工具元数据
│   ├── thinking.ts           # Thinking 提取与透传
│   ├── vision.ts             # 视觉降级处理（OCR / 外部 API）
│   ├── proxy-subscriptions.ts# 代理订阅导入与定时刷新
│   ├── airport-runtime.ts    # Mihomo 机场桥接 + 本地 SOCKS 入口管理
│   ├── queue.ts              # 请求队列与并发控制
│   ├── token-estimator.ts    # Token 估算
│   ├── chunked-action-guidance.ts # 分块 Action 指引
│   ├── request-logging.ts    # 请求日志
│   ├── web-logger.ts         # Web 日志推送（SSE）
│   ├── types.ts              # 类型定义
│   ├── openai-types.ts       # OpenAI 类型定义
│   └── public/               # Web 管理面板静态资源
│       ├── index.html        # 主页
│       └── admin.html        # 管理面板
├── test/                     # 单元测试 + E2E 测试
│   ├── unit-*.mjs            # 各模块单元测试
│   ├── e2e-chat.mjs          # 端到端对话测试
│   └── e2e-agentic.mjs       # Claude Code Agentic 压测
├── copy-public.mjs           # 构建后静态文件复制脚本
├── config.yaml               # 应用配置文件
├── docker-compose.yml
├── Dockerfile
└── package.json
```


## 技术架构

### 提示词注入策略：Cognitive Reframing（认知重构）

> 核心设计理念：不对抗模型的严格文档助手身份，而是顺应它在 Cursor 内部被强制赋予的角色。

Cursor 后端将 Claude 模型锁定为 "Documentation Assistant" 身份，工具被强行过滤为仅有  / 。本项目告诉模型它正在编写 API 系统的开发文档并需要输出工具示例，使其在不违背系统指令的前提下生成包含正确工具与参数的 JSON 块，代理层再将其转化为真实的工具调用发回客户端。

### 工具格式

Claude Code 发送工具定义 → 转换为 JSON action 格式注入提示词：

```json
{
  "tool": "Bash",
  "parameters": {
    "command": "ls -la"
  }
}
```

AI 按此格式输出 → 解析并转换为标准 Anthropic  content block。

### 多层拒绝防御

| 层级 | 位置 | 策略 |
|------|------|------|
| **L1: 上下文清洗** |  | 清洗历史中的拒绝文本，防止模型从历史"学会"拒绝 |
| **L2: XML 标签分离** |  | 将  与用户请求分离，确保 IDE 指令紧邻用户文本 |
| **L3: 项目意图注入** |  | 检测项目理解类问题，注入强制本地文件检查指令 |
| **L4: 输出拦截 + 自动重试** |  | 50+ 正则匹配拒绝文本，普通重试 + 提示词注入强制重试 |
| **L5: 响应清洗** |  |  将所有 Cursor 身份引用替换为 Claude |

### API 端点

| 端点 | 说明 |
|------|------|
|  | Anthropic Messages API（Claude Code） |
|  | OpenAI Chat Completions API |
|  | Cursor IDE Agent 模式（Responses API） |
|  | 可用模型列表 |
|  | Web 管理面板 |
|  | 实时日志（SSE） |
|  | 读取当前配置 |
|  | 保存配置（同步 .env.docker） |
|  | 代理订阅状态 |
|  | 重新拉取代理订阅 |
|  | 机场运行时状态 |
|  | 健康检查 |

## 更新日志

### v2.6.6 (2026-03-22) — Web 管理面板增强 + 拒绝防御强化

- **feat(admin)**: 重构  为异步读取，新增  双向同步，支持持久化配置与环境变量绑定
- **feat(converter)**: 新增项目理解意图检测，用户询问项目结构/架构时自动注入强制本地文件检查指令
- **fix(handler)**: 扩展拒绝检测模式，增加提示词注入强制重试，失败后返回原始响应而非固定兜底文本
- **feat(server)**: 根路径浏览器请求自动重定向至 ，动态查找静态资源目录
- **refactor(config)**: 导出  /  / ，支持  环境变量
- **feat(docker)**: 挂载  并注入 ， 改为可写挂载
- **build**: 新增 ，构建后自动复制静态文件到 
- **test**: 补充 admin-config / converter / handler 单元测试

### v2.6.6-fork.1 (2026-03-15) — Thinking / 截断恢复 / Docker 部署入口

- 运行时版本元数据对齐为 
- 集成 Thinking 提取与透传、阶梯式截断恢复、反拒绝提示强化
- OpenAI  兼容路径
- Docker 部署补充  配置入口

### v2.5.1 (2026-03-10) — 上下文智能压缩 + 截断检测

- 长对话老消息智能压缩（压缩率 70-80%），保留完整因果链语义
- 截断自动续写：检测未闭合代码块/XML，返回 
-  四层修复策略，解决长参数 JSON 解析崩溃

### v2.5.0 (2026-03-10) — Cursor IDE 适配 + 工具参数修复 + 增量流式

- 新增  端点，支持 Cursor IDE Agent 模式
- ：字段名映射、智能引号替换、模糊匹配修复
-  三层强制架构
- Anthropic / OpenAI 双端 128 字节增量流式优化

### v2.3.x (2026-03-06) — 视觉支持 + OpenAI 防御对齐

- 多模态视觉降级（本地 OCR + 外部视觉 API）
- OpenAI 端完整防御层对齐（拒绝检测 + 重试 + 响应清洗）
- 非工具场景认知重构前缀

### v2.2.0 (2026-03-05) — 三层身份保护

- 身份探针检测 + 话题拒绝检测 + 响应清洗

### v2.1.0 (2026-03-05) — 提示词策略重构

- 从"身份覆盖"改为"Cursor IDE 场景融合"，移除工具白名单限制

## 免责声明

**本项目仅供学习、研究和接口调试目的使用。**

1. 本项目并非 Cursor 官方项目，与 Cursor 及其母公司 Anysphere 没有任何关联。
2. 使用本项目前请确保已阅读并同意 Cursor 的服务条款。使用本项目可能引发账号封禁或其他限制。
3. 请合理使用，勿用于任何商业牟利、DDoS 攻击或大规模高频并发滥用等违规活动。
4. **作者及贡献者对任何人因使用本代码导致的损失、账号封禁或法律纠纷不承担任何责任。一切后果由使用者自行承担。**

## License

[MIT](LICENSE)
