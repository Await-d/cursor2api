/**
 * tool-fixer.ts - 工具参数修复
 *
 * 移植自 claude-api-2-cursor 的 tool_use_fixer.py
 * 修复 AI 模型输出的工具调用参数中常见的格式问题：
 * 1. 字段名映射 (file_path → path)
 * 2. 智能引号替换为普通引号
 * 3. StrReplace/search_replace 工具的精确匹配修复
 */

import { readFileSync, existsSync } from 'fs';

const SMART_DOUBLE_QUOTES = new Set([
    '\u00ab', '\u201c', '\u201d', '\u275e',
    '\u201f', '\u201e', '\u275d', '\u00bb',
]);

const SMART_SINGLE_QUOTES = new Set([
    '\u2018', '\u2019', '\u201a', '\u201b',
]);

/**
 * 字段名映射：将常见的错误字段名修正为标准字段名
 */
export function normalizeToolArguments(args: Record<string, unknown>): Record<string, unknown> {
    if (!args || typeof args !== 'object') return args;

    const normalized = { ...args };

    const fileValue = normalized.filePath ?? normalized.path ?? normalized.file_path ?? normalized.file;
    if (typeof fileValue === 'string' && fileValue) {
        if (!('filePath' in normalized)) normalized.filePath = fileValue;
        if (!('path' in normalized)) normalized.path = fileValue;
    }

    const oldStringValue = normalized.oldString ?? normalized.old_string ?? normalized.old_str;
    if (typeof oldStringValue === 'string' && oldStringValue) {
        if (!('oldString' in normalized)) normalized.oldString = oldStringValue;
        if (!('old_string' in normalized)) normalized.old_string = oldStringValue;
    }

    const newStringValue = normalized.newString ?? normalized.new_string ?? normalized.new_str ?? normalized.file_text;
    if (typeof newStringValue === 'string' && newStringValue) {
        if (!('newString' in normalized)) normalized.newString = newStringValue;
        if (!('new_string' in normalized)) normalized.new_string = newStringValue;
    }

    const insertLineValue = normalized.insertLine ?? normalized.insert_line;
    if (typeof insertLineValue === 'number') {
        if (!('insertLine' in normalized)) normalized.insertLine = insertLineValue;
        if (!('insert_line' in normalized)) normalized.insert_line = insertLineValue;
    }

    return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

type NormalizedQuestionOption = {
    label: string;
    description: string;
};

type NormalizedQuestionItem = {
    question: string;
    header: string;
    options: NormalizedQuestionOption[];
    multiple?: boolean;
    custom?: boolean;
};

function normalizeQuestionOption(option: unknown): NormalizedQuestionOption | null {
    if (typeof option === 'string') {
        const label = asNonEmptyString(option);
        if (!label) return null;
        return { label, description: label };
    }

    if (!isRecord(option)) return null;

    const label = asNonEmptyString(option.label)
        ?? asNonEmptyString(option.value)
        ?? asNonEmptyString(option.text)
        ?? asNonEmptyString(option.name);
    if (!label) return null;

    const description = asNonEmptyString(option.description)
        ?? asNonEmptyString(option.desc)
        ?? label;

    return { label, description };
}

function normalizeQuestionOptions(rawOptions: unknown): NormalizedQuestionOption[] {
    if (Array.isArray(rawOptions)) {
        return rawOptions
            .map(option => normalizeQuestionOption(option))
            .filter((option): option is NormalizedQuestionOption => option !== null);
    }

    if (isRecord(rawOptions)) {
        const directOption = normalizeQuestionOption(rawOptions);
        if (directOption) return [directOption];

        const options: NormalizedQuestionOption[] = [];
        for (const [key, value] of Object.entries(rawOptions)) {
            if (typeof value === 'string') {
                const label = asNonEmptyString(value) ?? asNonEmptyString(key);
                if (!label) continue;
                options.push({ label, description: label });
                continue;
            }

            if (isRecord(value)) {
                const normalized = normalizeQuestionOption(value)
                    ?? (() => {
                        const fallback = asNonEmptyString(key);
                        if (!fallback) return null;
                        return { label: fallback, description: fallback };
                    })();
                if (normalized) options.push(normalized);
            }
        }

        return options;
    }

    return [];
}

function normalizeQuestionItems(rawItems: unknown[]): NormalizedQuestionItem[] {
    const items: NormalizedQuestionItem[] = [];

    for (const rawItem of rawItems) {
        if (!isRecord(rawItem)) continue;

        const question = asNonEmptyString(rawItem.question)
            ?? asNonEmptyString(rawItem.label)
            ?? asNonEmptyString(rawItem.title)
            ?? asNonEmptyString(rawItem.name)
            ?? asNonEmptyString(rawItem.header);
        const header = asNonEmptyString(rawItem.header) ?? question;

        let options = normalizeQuestionOptions(rawItem.options);
        if (options.length === 0) {
            const singleOptionLabel = asNonEmptyString(rawItem.value)
                ?? asNonEmptyString(rawItem.option)
                ?? asNonEmptyString(rawItem.label);
            if (singleOptionLabel) {
                const description = asNonEmptyString(rawItem.description) ?? singleOptionLabel;
                options = [{ label: singleOptionLabel, description }];
            }
        }

        if (!question || !header || options.length === 0) continue;

        const normalizedItem: NormalizedQuestionItem = {
            question,
            header,
            options,
        };

        if (typeof rawItem.multiple === 'boolean') {
            normalizedItem.multiple = rawItem.multiple;
        }
        if (typeof rawItem.custom === 'boolean') {
            normalizedItem.custom = rawItem.custom;
        }

        items.push(normalizedItem);
    }

    return items;
}

function normalizeQuestionArguments(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    const normalizedToolName = (toolName || '').trim().toLowerCase();
    if (normalizedToolName !== 'question') return args;
    if (!args || typeof args !== 'object') return args;

    const normalized: Record<string, unknown> = { ...args };

    const rawItems = Array.isArray(normalized.questions)
        ? normalized.questions
        : Array.isArray(normalized.fields)
            ? normalized.fields
            : isRecord(normalized.questions)
                ? [normalized.questions]
                : isRecord(normalized.fields)
                    ? [normalized.fields]
                    : [];

    let normalizedItems = normalizeQuestionItems(rawItems);

    if (normalizedItems.length === 0) {
        const fallbackQuestion = asNonEmptyString(normalized.question)
            ?? asNonEmptyString(normalized.header)
            ?? asNonEmptyString(normalized.label);
        const fallbackHeader = asNonEmptyString(normalized.header) ?? fallbackQuestion;

        let fallbackOptions = normalizeQuestionOptions(normalized.options);
        if (fallbackOptions.length === 0) {
            const fallbackLabel = asNonEmptyString(normalized.label)
                ?? asNonEmptyString(normalized.value)
                ?? asNonEmptyString(normalized.option);
            if (fallbackLabel) {
                fallbackOptions = [{ label: fallbackLabel, description: fallbackLabel }];
            }
        }

        if (fallbackQuestion && fallbackHeader && fallbackOptions.length > 0) {
            const fallbackItem: NormalizedQuestionItem = {
                question: fallbackQuestion,
                header: fallbackHeader,
                options: fallbackOptions,
            };

            if (typeof normalized.multiple === 'boolean') {
                fallbackItem.multiple = normalized.multiple;
            }
            if (typeof normalized.custom === 'boolean') {
                fallbackItem.custom = normalized.custom;
            }

            normalizedItems = [fallbackItem];
        }
    }

    if (normalizedItems.length > 0) {
        normalized.questions = normalizedItems;
    }

    return normalized;
}

/**
 * 将智能引号（中文引号等）替换为普通 ASCII 引号
 */
export function replaceSmartQuotes(text: string): string {
    const chars = [...text];
    return chars.map(ch => {
        if (SMART_DOUBLE_QUOTES.has(ch)) return '"';
        if (SMART_SINGLE_QUOTES.has(ch)) return "'";
        return ch;
    }).join('');
}

function buildFuzzyPattern(text: string): string {
    const parts: string[] = [];
    for (const ch of text) {
        if (SMART_DOUBLE_QUOTES.has(ch) || ch === '"') {
            parts.push('["\u00ab\u201c\u201d\u275e\u201f\u201e\u275d\u00bb]');
        } else if (SMART_SINGLE_QUOTES.has(ch) || ch === "'") {
            parts.push("['\u2018\u2019\u201a\u201b]");
        } else if (ch === ' ' || ch === '\t') {
            parts.push('\\s+');
        } else if (ch === '\\') {
            parts.push('\\\\{1,2}');
        } else {
            parts.push(escapeRegExp(ch));
        }
    }
    return parts.join('');
}

function escapeRegExp(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 修复 StrReplace / search_replace 工具的 old_string 精确匹配问题
 *
 * 当 AI 输出的 old_string 包含智能引号或微小格式差异时，
 * 尝试在实际文件中进行容错匹配，找到唯一匹配后替换为精确文本
 */
export function repairExactMatchToolArguments(
    toolName: string,
    args: Record<string, unknown>,
): Record<string, unknown> {
    if (!args || typeof args !== 'object') return args;

    const lowerName = (toolName || '').toLowerCase();
    if (!lowerName.includes('str_replace') && !lowerName.includes('search_replace') && !lowerName.includes('strreplace')) {
        return args;
    }

    const oldString = (args.old_string ?? args.old_str) as string | undefined;
    if (!oldString) return args;

    const filePath = (args.path ?? args.file_path) as string | undefined;
    if (!filePath) return args;

    try {
        if (!existsSync(filePath)) return args;
        const content = readFileSync(filePath, 'utf-8');

        if (content.includes(oldString)) return args;

        const pattern = buildFuzzyPattern(oldString);
        const regex = new RegExp(pattern, 'g');
        const matches = [...content.matchAll(regex)];

        if (matches.length !== 1) return args;

        const matchedText = matches[0][0];

        if ('old_string' in args) args.old_string = matchedText;
        else if ('old_str' in args) args.old_str = matchedText;

        const newString = (args.new_string ?? args.new_str) as string | undefined;
        if (newString) {
            const fixed = replaceSmartQuotes(newString);
            if ('new_string' in args) args.new_string = fixed;
            else if ('new_str' in args) args.new_str = fixed;
        }

        console.log(`[ToolFixer] 修复了 ${toolName} 的 old_string 精确匹配`);
    } catch {
        // best-effort: 文件读取失败不阻塞请求
    }

    return args;
}

export function repairBashCommandArguments(
    toolName: string,
    args: Record<string, unknown>,
): Record<string, unknown> {
    const lowerName = (toolName || '').toLowerCase();
    if (!/^(bash|execute_command|runcommand)$/.test(lowerName)) {
        return args;
    }

    const command = args.command;
    if (typeof command !== 'string' || !/<<[-~]?\s*['"]?\w+['"]?/.test(command)) {
        return args;
    }

    args.command = command.replace(/(?:\n\s*(?:[\]}],?|"|')\s*)+(?:\n```)?\s*$/, '');
    return args;
}

/**
 * 对解析出的工具调用应用全部修复
 */
export function fixToolCallArguments(
    toolName: string,
    args: Record<string, unknown>,
): Record<string, unknown> {
    args = normalizeToolArguments(args);
    args = normalizeQuestionArguments(toolName, args);
    args = repairExactMatchToolArguments(toolName, args);
    args = repairBashCommandArguments(toolName, args);
    return args;
}
