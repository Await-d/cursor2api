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
    args = repairExactMatchToolArguments(toolName, args);
    args = repairBashCommandArguments(toolName, args);
    return args;
}
