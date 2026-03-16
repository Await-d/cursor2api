import type { AnthropicRequest } from './types.js';

export interface ThinkingBlock {
    thinking: string;
}

export interface ExtractThinkingResult {
    thinkingBlocks: ThinkingBlock[];
    cleanText: string;
}

export function extractThinking(text: string): ExtractThinkingResult {
    const thinkingBlocks: ThinkingBlock[] = [];

    if (!text || !text.includes('<thinking>')) {
        return { thinkingBlocks, cleanText: text };
    }

    const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/g;
    let match: RegExpExecArray | null;
    const ranges: Array<{ start: number; end: number }> = [];

    while (true) {
        match = thinkingRegex.exec(text);
        if (match === null) break;
        const thinkingContent = match[1]?.trim();
        if (thinkingContent) {
            thinkingBlocks.push({ thinking: thinkingContent });
        }
        ranges.push({ start: match.index, end: match.index + match[0].length });
    }

    const lastOpenIdx = text.lastIndexOf('<thinking>');
    const lastCloseIdx = text.lastIndexOf('</thinking>');
    if (lastOpenIdx >= 0 && (lastCloseIdx < 0 || lastOpenIdx > lastCloseIdx)) {
        const unclosedContent = text.substring(lastOpenIdx + '<thinking>'.length).trim();
        if (unclosedContent) {
            thinkingBlocks.push({ thinking: unclosedContent });
        }
        ranges.push({ start: lastOpenIdx, end: text.length });
    }

    ranges.sort((a, b) => b.start - a.start);
    let cleanText = text;
    for (const range of ranges) {
        cleanText = cleanText.substring(0, range.start) + cleanText.substring(range.end);
    }

    cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();

    if (thinkingBlocks.length > 0) {
        console.log(`[Thinking] 提取到 ${thinkingBlocks.length} 个 thinking 块, 总 ${thinkingBlocks.reduce((sum, block) => sum + block.thinking.length, 0)} chars`);
    }

    return { thinkingBlocks, cleanText };
}

export function isAnthropicThinkingEnabled(
    requestThinking: AnthropicRequest['thinking'] | undefined,
    defaultEnabled: boolean,
): boolean {
    if (requestThinking?.type === 'enabled') return true;
    if (requestThinking?.type === 'disabled') return false;
    return defaultEnabled;
}

export function extractThinkingIfEnabled(text: string, enabled: boolean): ExtractThinkingResult {
    if (!enabled) {
        return { thinkingBlocks: [], cleanText: text };
    }

    return extractThinking(text);
}

export const THINKING_HINT = `You may use <thinking>...</thinking> for brief private reasoning. HARD LIMITS: max 3 lines, max 120 words. Do NOT write code, full solutions, or long analysis inside thinking. Never repeat thinking content in the final response.`;
