import { getConfig } from './config.js';
import type {
    AnthropicContentBlock,
    AnthropicMessage,
    AnthropicRequest,
    AnthropicTool,
    CursorChatRequest,
} from './types.js';

const WESTERN_RANGES: Array<[number, number]> = [
    [0x0000, 0x007f],
    [0x0080, 0x00ff],
    [0x0100, 0x024f],
    [0x1e00, 0x1eff],
    [0x2c60, 0x2c7f],
    [0xa720, 0xa7ff],
    [0xab30, 0xab6f],
];

function isNonWesternChar(char: string): boolean {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) return false;
    return !WESTERN_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

function getAdjustedTokenCount(baseTokens: number): number {
    if (baseTokens < 100) return baseTokens * 1.5;
    if (baseTokens < 200) return baseTokens * 1.3;
    if (baseTokens < 300) return baseTokens * 1.25;
    if (baseTokens < 800) return baseTokens * 1.2;
    return baseTokens;
}

function extractSystemTexts(system?: AnthropicRequest['system'], includeInjectedPrompt = true): string[] {
    const parts: string[] = [];

    if (typeof system === 'string') {
        const trimmed = system.trim();
        if (trimmed) parts.push(trimmed);
    } else if (Array.isArray(system)) {
        for (const block of system) {
            if (block.type !== 'text' || typeof block.text !== 'string') continue;
            const trimmed = block.text.trim();
            if (trimmed) parts.push(trimmed);
        }
    }

    if (includeInjectedPrompt) {
        const injectedPrompt = getConfig().systemPromptInject.trim();
        if (injectedPrompt) parts.push(injectedPrompt);
    }

    return parts;
}

function estimateMessageContentTokens(content: AnthropicMessage['content']): number {
    if (typeof content === 'string') {
        return estimateTextTokens(content);
    }

    if (!Array.isArray(content)) {
        return estimateTextTokens(String(content ?? ''));
    }

    let total = 0;

    for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
            total += estimateTextTokens(block.text);
            continue;
        }

        if (block.type === 'tool_result') {
            total += estimateToolResultTokens(block);
            continue;
        }

        if (block.type === 'tool_use') {
            total += estimateToolUseTokens(block);
        }
    }

    return total;
}

function estimateToolUseTokens(block: AnthropicContentBlock): number {
    let total = 0;
    if (block.name) total += estimateTextTokens(block.name);
    if (block.input) total += estimateTextTokens(JSON.stringify(block.input));
    return total;
}

function estimateToolResultTokens(block: AnthropicContentBlock): number {
    if (typeof block.content === 'string') {
        return estimateTextTokens(block.content);
    }

    if (!Array.isArray(block.content)) {
        return 0;
    }

    let total = 0;
    for (const item of block.content) {
        if (item.type === 'text' && typeof item.text === 'string') {
            total += estimateTextTokens(item.text);
        }
    }
    return total;
}

function estimateToolDefinitionTokens(tools?: AnthropicTool[]): number {
    if (!tools?.length) return 0;

    let total = 0;
    for (const tool of tools) {
        total += estimateTextTokens(tool.name);
        total += estimateTextTokens(tool.description || '');
        total += estimateTextTokens(JSON.stringify(tool.input_schema || {}));
    }

    return total;
}

export function estimateTextTokens(text: string): number {
    if (!text) return 1;

    const charUnits = Array.from(text).reduce((sum, char) => sum + (isNonWesternChar(char) ? 4 : 1), 0);
    const adjusted = getAdjustedTokenCount(charUnits / 4);
    return Math.max(1, Math.floor(adjusted));
}

export function estimateAnthropicInputTokens(
    req: Pick<AnthropicRequest, 'system' | 'messages' | 'tools'>,
    options?: { includeInjectedPrompt?: boolean },
): number {
    const includeInjectedPrompt = options?.includeInjectedPrompt !== false;
    let total = 0;

    for (const text of extractSystemTexts(req.system, includeInjectedPrompt)) {
        total += estimateTextTokens(text);
    }

    for (const message of req.messages ?? []) {
        total += estimateMessageContentTokens(message.content);
    }

    total += estimateToolDefinitionTokens(req.tools);
    return Math.max(1, total);
}

export function estimateAnthropicOutputTokens(blocks: AnthropicContentBlock[]): number {
    let total = 0;

    for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
            total += estimateTextTokens(block.text);
            continue;
        }

        if (block.type === 'thinking' && typeof block.thinking === 'string') {
            total += estimateTextTokens(block.thinking);
            continue;
        }

        if (block.type === 'tool_use') {
            total += estimateTextTokens(JSON.stringify(block.input || {}));
            if (block.name) total += estimateTextTokens(block.name);
        }
    }

    return Math.max(1, total);
}

export function estimateCursorInputTokens(req: CursorChatRequest): number {
    let total = 0;

    for (const context of req.context ?? []) {
        if (context.content) total += estimateTextTokens(context.content);
        if (context.filePath) total += estimateTextTokens(context.filePath);
    }

    for (const message of req.messages ?? []) {
        for (const part of message.parts ?? []) {
            if (part.text) total += estimateTextTokens(part.text);
        }
    }

    return Math.max(1, total);
}

export function estimateOpenAICompletionTokens(
    content: string | null,
    toolCalls?: Array<{ function: { arguments: string; name?: string } }>,
    reasoningContent?: string | null,
): number {
    let total = content ? estimateTextTokens(content) : 0;

    if (reasoningContent) {
        total += estimateTextTokens(reasoningContent);
    }

    for (const toolCall of toolCalls ?? []) {
        if (toolCall.function.name) {
            total += estimateTextTokens(toolCall.function.name);
        }
        total += estimateTextTokens(toolCall.function.arguments || '');
    }

    return Math.max(1, total);
}
