# .agentdocs/workflow/260320-透传真实-token-usage.md

## Task Overview
将 Cursor 上游返回的真实 token usage 透传到当前代理，对接 Anthropic / OpenAI 输出；暂停使用估算 token，但保留现有业务代码与 fallback 逻辑。

## Current Analysis
- 现有 `CursorMessage` 类型不包含 `metadata`，会丢掉对话历史中的 `assistant.metadata.usage`。
- 现有 `CursorSSEEvent` 只支持顶层 `usage.prompt_tokens/completion_tokens/total_tokens`，无法表达 `inputTokens/outputTokens/reasoningTokens/cachedInputTokens`。
- `handler.ts` 与 `openai-handler.ts` 当前主要返回本地估算 usage，而不是上游真实 usage。

## Solution Design
- 在类型层新增真实 Cursor usage 结构，并支持从 `assistant.metadata.usage` 与顶层 `event.usage` 两种来源提取。
- 在 `cursor-client.ts` 中统一解析真实 usage，并让 full-response API 把文本和 usage 一起返回。
- 在 Anthropic / OpenAI handler 中优先使用真实 usage；仅在上游缺失时走原有 estimator fallback。
- 增加针对 nested metadata usage 与 legacy top-level usage 的测试覆盖。

## Implementation Plan

### Phase 1: Usage capture
- [ ] T-01: 扩展 `src/types.ts` 支持真实 Cursor usage / metadata 结构
- [ ] T-02: 修改 `src/cursor-client.ts` 统一提取真实 usage

### Phase 2: Response mapping
- [ ] T-03: 修改 `src/handler.ts` 优先透传真实 usage 到 Anthropic 输出
- [ ] T-04: 修改 `src/openai-handler.ts` 优先透传真实 usage 到 OpenAI 输出

### Phase 3: Verification
- [ ] T-05: 添加/更新测试覆盖真实 usage 与 fallback
- [ ] T-06: 运行 build 与目标测试完成验证

## Notes
- 用户要求暂停使用估算 token，但业务代码不删除，因此保留 estimator 作为缺失上游 usage 时的后备路径。
