/**
 * test/unit-tolerant-parse.mjs
 *
 * 单元测试：tolerantParse 和 parseToolCalls 的各种边界场景
 * 运行方式：node test/unit-tolerant-parse.mjs
 *
 * 无需服务器，完全离线运行。
 */

// ─── 从 dist/ 中直接引入已编译的 converter（需要先 npm run build）──────────
// 如果没有 dist，也可以把 tolerantParse 的实现复制到此处做测试

// ─── 内联 tolerantParse（与 src/converter.ts 保持同步）──────────────────────
function normalizeJsonLikeSingleQuotedStrings(input) {
    let result = '';
    let index = 0;
    let inDoubleQuotedString = false;
    let doubleQuotedEscaped = false;

    while (index < input.length) {
        const char = input[index];

        if (inDoubleQuotedString) {
            result += char;
            if (doubleQuotedEscaped) {
                doubleQuotedEscaped = false;
            } else if (char === '\\') {
                doubleQuotedEscaped = true;
            } else if (char === '"') {
                inDoubleQuotedString = false;
            }
            index++;
            continue;
        }

        if (char === '"') {
            inDoubleQuotedString = true;
            result += char;
            index++;
            continue;
        }

        if (char !== "'") {
            result += char;
            index++;
            continue;
        }

        index++;
        let singleQuotedValue = '';
        let singleQuotedClosed = false;

        while (index < input.length) {
            const valueChar = input[index];
            if (valueChar === '\\' && index + 1 < input.length) {
                const escapedChar = input[index + 1];
                if (escapedChar === 'n') singleQuotedValue += '\n';
                else if (escapedChar === 'r') singleQuotedValue += '\r';
                else if (escapedChar === 't') singleQuotedValue += '\t';
                else singleQuotedValue += escapedChar;
                index += 2;
                continue;
            }

            if (valueChar === "'") {
                singleQuotedClosed = true;
                index++;
                break;
            }

            singleQuotedValue += valueChar;
            index++;
        }

        if (!singleQuotedClosed) {
            result += "'" + singleQuotedValue;
            break;
        }

        result += JSON.stringify(singleQuotedValue);
    }

    return result;
}

function tolerantParse(jsonStr) {
    const normalizedJsonStr = normalizeJsonLikeSingleQuotedStrings(jsonStr);

    try {
        return JSON.parse(normalizedJsonStr);
    } catch (_e1) {
        /* pass */
    }

    let inString = false;
    let fixed = '';
    const bracketStack = [];

    for (let i = 0; i < normalizedJsonStr.length; i++) {
        const char = normalizedJsonStr[i];
        if (char === '"') {
            let backslashCount = 0;
            for (let j = fixed.length - 1; j >= 0 && fixed[j] === '\\'; j--) backslashCount++;
            if (backslashCount % 2 === 0) inString = !inString;
            fixed += char;
            continue;
        }
        if (inString) {
            if (char === '\n') fixed += '\\n';
            else if (char === '\r') fixed += '\\r';
            else if (char === '\t') fixed += '\\t';
            else fixed += char;
        } else {
            if (char === '{' || char === '[') bracketStack.push(char === '{' ? '}' : ']');
            else if (char === '}' || char === ']') { if (bracketStack.length > 0) bracketStack.pop(); }
            fixed += char;
        }
    }

    if (inString) fixed += '"';
    while (bracketStack.length > 0) fixed += bracketStack.pop();
    fixed = fixed.replace(/,\s*([}\]])/g, '$1');

    try {
        return JSON.parse(fixed);
    } catch (_e2) {
        const lastBrace = fixed.lastIndexOf('}');
        if (lastBrace > 0) {
            try { return JSON.parse(fixed.substring(0, lastBrace + 1)); } catch { /* ignore */ }
        }
        try {
            const toolMatch = normalizedJsonStr.match(/"(?:tool|name)"\s*:\s*"([^"]+)"/);
            if (toolMatch) {
                const toolName = toolMatch[1];
                const paramsMatch = normalizedJsonStr.match(/"(?:parameters|arguments|input)"\s*:\s*(\{[\s\S]*)/);
                let params = {};
                if (paramsMatch) {
                    const paramsStr = paramsMatch[1];
                    let depth = 0;
                    let end = -1;
                    let pInString = false;
                    for (let i = 0; i < paramsStr.length; i++) {
                        const c = paramsStr[i];
                        if (c === '"') {
                            let backslashCount = 0;
                            for (let j = i - 1; j >= 0 && paramsStr[j] === '\\'; j--) backslashCount++;
                            if (backslashCount % 2 === 0) pInString = !pInString;
                        }
                        if (!pInString) {
                            if (c === '{') depth++;
                            if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
                        }
                    }
                    if (end > 0) {
                        const rawParams = paramsStr.substring(0, end + 1);
                        try {
                            params = JSON.parse(rawParams);
                        } catch {
                            const fieldRegex = /"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
                            for (let fm = fieldRegex.exec(rawParams); fm !== null; fm = fieldRegex.exec(rawParams)) {
                                params[fm[1]] = fm[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t');
                            }
                        }
                    }
                }
                return { tool: toolName, parameters: params };
            }
        } catch { /* ignore */ }

        try {
            const toolMatch2 = normalizedJsonStr.match(/["'](?:tool|name)["']\s*:\s*["']([^"']+)["']/);
            if (toolMatch2) {
                const toolName = toolMatch2[1];
                const params = {};
                const bigValueFields = ['content', 'command', 'text', 'new_string', 'new_str', 'file_text', 'code'];
                const smallFieldRegex = /"(file_path|path|file|old_string|old_str|insert_line|mode|encoding|description|language|name)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
                for (let sfm = smallFieldRegex.exec(normalizedJsonStr); sfm !== null; sfm = smallFieldRegex.exec(normalizedJsonStr)) {
                    params[sfm[1]] = sfm[2]
                        .replace(/\\n/g, '\n')
                        .replace(/\\t/g, '\t')
                        .replace(/\\r/g, '\r')
                        .replace(/\\\\/g, '\\');
                }
                for (const field of bigValueFields) {
                    const fieldStart = normalizedJsonStr.indexOf(`"${field}"`);
                    if (fieldStart === -1) continue;
                    const colonPos = normalizedJsonStr.indexOf(':', fieldStart + field.length + 2);
                    if (colonPos === -1) continue;
                    const valueStart = normalizedJsonStr.indexOf('"', colonPos);
                    if (valueStart === -1) continue;
                    let valueEnd = normalizedJsonStr.length - 1;
                    while (valueEnd > valueStart && /[}\]\s,]/.test(normalizedJsonStr[valueEnd])) valueEnd--;
                    if (normalizedJsonStr[valueEnd] === '"' && valueEnd > valueStart + 1) {
                        const rawValue = normalizedJsonStr.substring(valueStart + 1, valueEnd);
                        try {
                            params[field] = JSON.parse(`"${rawValue}"`);
                        } catch {
                            params[field] = rawValue
                                .replace(/\\n/g, '\n')
                                .replace(/\\t/g, '\t')
                                .replace(/\\r/g, '\r')
                                .replace(/\\\\/g, '\\')
                                .replace(/\\"/g, '"');
                        }
                    }
                }
                if (Object.keys(params).length > 0) {
                    return { tool: toolName, parameters: params };
                }
            }
        } catch { /* ignore */ }

        throw _e2;
    }
}

// ─── 内联 parseToolCalls（与 src/converter.ts 保持同步）────────────────────
function parseToolCalls(responseText) {
    const toolCalls = [];
    let cleanText = responseText;

    function extractJsonValueSlice(jsonStr, startIndex) {
        let index = startIndex;
        while (index < jsonStr.length && /\s/.test(jsonStr[index])) index++;
        if (index >= jsonStr.length) return null;

        const startChar = jsonStr[index];
        if (startChar === '{' || startChar === '[') {
            const stack = [startChar];
            let inString = false;
            let escaped = false;
            for (let i = index + 1; i < jsonStr.length; i++) {
                const char = jsonStr[i];
                if (inString) {
                    if (escaped) escaped = false;
                    else if (char === '\\') escaped = true;
                    else if (char === '"') inString = false;
                    continue;
                }
                if (char === '"') {
                    inString = true;
                    continue;
                }
                if (char === '{' || char === '[') {
                    stack.push(char);
                    continue;
                }
                if (char === '}' || char === ']') {
                    const expected = char === '}' ? '{' : '[';
                    if (stack[stack.length - 1] === expected) {
                        stack.pop();
                        if (stack.length === 0) return jsonStr.slice(index, i + 1);
                    }
                }
            }
            return jsonStr.slice(index);
        }

        if (startChar === '"') {
            let escaped = false;
            for (let i = index + 1; i < jsonStr.length; i++) {
                const char = jsonStr[i];
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (char === '\\') {
                    escaped = true;
                    continue;
                }
                if (char === '"') return jsonStr.slice(index, i + 1);
            }
            return jsonStr.slice(index);
        }

        let endIndex = index;
        while (endIndex < jsonStr.length && !/[\s,}\]]/.test(jsonStr[endIndex])) endIndex++;
        return jsonStr.slice(index, endIndex);
    }

    function extractStructuredArgumentRawValue(jsonStr) {
        for (const fieldName of ['parameters', 'arguments', 'input']) {
            const fieldRegex = new RegExp(`"${fieldName}"\\s*:`);
            const fieldMatch = fieldRegex.exec(jsonStr);
            if (!fieldMatch) continue;

            const rawValue = extractJsonValueSlice(jsonStr, fieldMatch.index + fieldMatch[0].length);
            if (rawValue) return rawValue;
        }
        return null;
    }

    function hasMeaningfulStructuredArgumentPayload(jsonStr) {
        const rawValue = extractStructuredArgumentRawValue(jsonStr);
        if (!rawValue) return false;
        const trimmed = rawValue.trim();
        return trimmed !== '' && trimmed !== '{}' && trimmed !== '[]' && trimmed !== 'null';
    }

    function isEmptyArgumentObject(value) {
        return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0;
    }

    function hasToolCallSignature(jsonStr) {
        return (/["']tool["']\s*:/i.test(jsonStr) || /["']name["']\s*:/i.test(jsonStr))
            && /["'](?:parameters|arguments|input)["']\s*:/i.test(jsonStr);
    }

    function isRecord(value) {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    function isQuestionOption(value) {
        return isRecord(value)
            && typeof value.label === 'string'
            && typeof value.description === 'string';
    }

    function isQuestionItem(value) {
        return isRecord(value)
            && typeof value.question === 'string'
            && typeof value.header === 'string'
            && Array.isArray(value.options)
            && value.options.length > 0
            && value.options.every(isQuestionOption);
    }

    function hasValidToolArguments(toolName, args) {
        const normalizedToolName = toolName.trim().toLowerCase();
        if (normalizedToolName === 'question') {
            return isRecord(args)
                && Array.isArray(args.questions)
                && args.questions.length > 0
                && args.questions.every(isQuestionItem);
        }

        if (normalizedToolName === 'ask_followup_question') {
            return isRecord(args)
                && typeof args.question === 'string'
                && (!('options' in args)
                    || (Array.isArray(args.options) && args.options.every(option => typeof option === 'string')));
        }

        return true;
    }

    function looksLikeToolCallCandidate(fullBlock, jsonStr) {
        if (/^```json\s+action\b/i.test(fullBlock)) return true;
        return hasToolCallSignature(jsonStr);
    }

    function normalizeCandidateJson(jsonStr) {
        const normalizedLines = jsonStr
            .split('\n')
            .map(line => line.replace(/^\s*(?:>\s*)?(?:(?:[-*]|\d+[.)]|•)\s*)?(?=[{\[}\]"])/, ''))
            .join('\n');

        return normalizedLines
            .replace(/^`+\s*/, '')
            .replace(/\s*`+$/, '')
            .trim();
    }

    function getInlineObjectSignatureSlice(text, objectStart) {
        const maxEnd = Math.min(text.length, objectStart + 240);
        const fenceIndex = text.indexOf('```', objectStart);
        const end = fenceIndex >= 0 && fenceIndex < maxEnd ? fenceIndex : maxEnd;
        return text.slice(objectStart, end);
    }

    function candidatePriority(kind) {
        switch (kind) {
            case 'fenced':
                return 0;
            case 'unterminatedFence':
                return 1;
            case 'inlineJsonAction':
                return 2;
            case 'inlineObject':
                return 3;
            default:
                return 4;
        }
    }

    function rangesOverlap(a, b) {
        return a.start < b.end && b.start < a.end;
    }

    function expandCandidateStartToLinePrefix(text, objectStart) {
        let lineStart = objectStart;
        while (lineStart > 0 && text[lineStart - 1] !== '\n') {
            lineStart--;
        }

        const prefix = text.slice(lineStart, objectStart);
        if (/^\s*(?:>\s*)?(?:(?:[-*]|\d+[.)]|•)\s*)?$/.test(prefix)) {
            return lineStart;
        }

        return objectStart;
    }

    function collectInlineObjectCandidates(text) {
        const candidates = [];
        let inString = false;
        let escaped = false;
        let depth = 0;
        let objectStart = -1;

        for (let i = 0; i < text.length; i++) {
            const char = text[i];

            if (inString) {
                if (escaped) {
                    escaped = false;
                } else if (char === '\\') {
                    escaped = true;
                } else if (char === '"') {
                    inString = false;
                }
                continue;
            }

            if (char === '"') {
                inString = true;
                continue;
            }

            if (char === '{') {
                if (depth === 0) {
                    if (!hasToolCallSignature(getInlineObjectSignatureSlice(text, i))) continue;
                    objectStart = i;
                }
                depth++;
                continue;
            }

            if (char === '}' && depth > 0) {
                depth--;
                if (depth === 0 && objectStart >= 0) {
                    const fullStart = expandCandidateStartToLinePrefix(text, objectStart);
                    const full = text.slice(fullStart, i + 1);
                    candidates.push({ full, json: full, start: fullStart, end: i + 1, kind: 'inlineObject' });
                    objectStart = -1;
                }
            }
        }

        if (depth > 0 && objectStart >= 0) {
            const fullStart = expandCandidateStartToLinePrefix(text, objectStart);
            const full = text.slice(fullStart);
            candidates.push({ full, json: full, start: fullStart, end: text.length, kind: 'inlineObject' });
        }

        return candidates;
    }

    function collectUnterminatedFenceCandidates(text) {
        const candidates = [];
        const openFenceRegex = /```json(?:\s+action)?\s*/gi;

        for (let match = openFenceRegex.exec(text); match !== null; match = openFenceRegex.exec(text)) {
            const start = match.index ?? 0;
            const contentStart = start + match[0].length;
            if (text.slice(contentStart).includes('```')) continue;

            candidates.push({
                full: text.slice(start),
                json: text.slice(contentStart),
                start,
                end: text.length,
                kind: 'unterminatedFence',
            });
        }

        return candidates;
    }

    function collectInlineJsonActionCandidates(text) {
        const candidates = [];
        const inlineJsonActionRegex = /json\s+action\b/gi;

        for (let match = inlineJsonActionRegex.exec(text); match !== null; match = inlineJsonActionRegex.exec(text)) {
            const start = match.index ?? 0;
            let jsonStart = start + match[0].length;
            while (jsonStart < text.length && /\s/.test(text[jsonStart])) jsonStart++;

            const json = extractJsonValueSlice(text, jsonStart);
            if (!json) continue;

            candidates.push({
                full: text.slice(start, jsonStart) + json,
                json,
                start,
                end: jsonStart + json.length,
                kind: 'inlineJsonAction',
            });
        }

        return candidates;
    }

    function parseToolCallBlock(jsonStr) {
        const parsed = tolerantParse(jsonStr);
        if (parsed && (parsed.tool || parsed.name)) {
            const name = parsed.tool || parsed.name || '';
            const args = parsed.parameters || parsed.arguments || parsed.input || {};
            if (hasMeaningfulStructuredArgumentPayload(jsonStr) && isEmptyArgumentObject(args)) {
                return null;
            }
            if (!hasValidToolArguments(name, args)) {
                return null;
            }
            return {
                name,
                arguments: args,
            };
        }
        return null;
    }

    const candidates = [];
    const fencedRegex = /```json(?:\s+action)?\s*([\s\S]*?)\s*```/gi;
    for (let match = fencedRegex.exec(responseText); match !== null; match = fencedRegex.exec(responseText)) {
        const start = match.index ?? 0;
        candidates.push({ full: match[0], json: match[1], start, end: start + match[0].length, kind: 'fenced' });
    }
    for (const candidate of collectUnterminatedFenceCandidates(responseText)) {
        candidates.push(candidate);
    }
    for (const candidate of collectInlineJsonActionCandidates(responseText)) {
        candidates.push(candidate);
    }
    for (const candidate of collectInlineObjectCandidates(responseText)) {
        candidates.push(candidate);
    }

    candidates.sort((a, b) => candidatePriority(a.kind) - candidatePriority(b.kind) || (a.end - a.start) - (b.end - b.start) || a.start - b.start);
    const filtered = [];
    for (const candidate of candidates) {
        if (filtered.some(prev => rangesOverlap(candidate, prev))) continue;
        filtered.push(candidate);
    }

    filtered.sort((a, b) => a.start - b.start || a.end - b.end);

    for (const candidate of filtered) {
        const normalizedJson = normalizeCandidateJson(candidate.json);
        if (!looksLikeToolCallCandidate(candidate.full, normalizedJson)) continue;
        try {
            const parsed = parseToolCallBlock(normalizedJson);
            if (parsed) {
                toolCalls.push(parsed);
            }
        } catch (e) {
            console.error(`  ⚠  tolerantParse 失败:`, e.message);
        }
        cleanText = cleanText.replace(candidate.full, '');
    }

    return { toolCalls, cleanText: cleanText.trim() };
}

function hasToolCalls(text) {
    if (/```json\s+action/i.test(text)
        || /json\s+action/i.test(text)
        || (/("tool"|"name")\s*:\s*"/i.test(text) && /"(?:parameters|arguments|input)"\s*:/i.test(text))) {
        return true;
    }

    return parseToolCalls(text).toolCalls.length > 0;
}

// ─── 测试框架（极简）────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅  ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌  ${name}`);
        console.error(`      ${e.message}`);
        failed++;
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
    const as = JSON.stringify(a), bs = JSON.stringify(b);
    if (as !== bs) throw new Error(msg || `Expected ${bs}, got ${as}`);
}

// ════════════════════════════════════════════════════════════════════
// 1. tolerantParse — 正常 JSON
// ════════════════════════════════════════════════════════════════════
console.log('\n📦 [1] tolerantParse — 正常 JSON\n');

test('标准 JSON 对象', () => {
    const r = tolerantParse('{"tool":"Read","parameters":{"path":"/foo"}}');
    assertEqual(r.tool, 'Read');
    assertEqual(r.parameters.path, '/foo');
});

test('带换行缩进的 JSON', () => {
    const r = tolerantParse(`{
  "tool": "Write",
  "parameters": {
    "file_path": "src/index.ts",
    "content": "hello world"
  }
}`);
    assertEqual(r.tool, 'Write');
});

test('空对象', () => {
    const r = tolerantParse('{}');
    assertEqual(r, {});
});

// ════════════════════════════════════════════════════════════════════
// 2. tolerantParse — 字符串内含裸换行（流式输出常见场景）
// ════════════════════════════════════════════════════════════════════
console.log('\n📦 [2] tolerantParse — 字符串内含裸换行\n');

test('value 中含裸 \\n', () => {
    // 模拟：content 字段值里有多行文本，但 JSON 没有转义换行
    const raw = '{"tool":"Write","parameters":{"content":"line1\nline2\nline3"}}';
    const r = tolerantParse(raw);
    assert(r.parameters.content.includes('\n') || r.parameters.content.includes('\\n'),
        'content 应包含换行信息');
});

test('value 中含裸 \\t', () => {
    const raw = '{"tool":"Bash","parameters":{"command":"echo\there"}}';
    const r = tolerantParse(raw);
    assert(r.parameters.command !== undefined);
});

// ════════════════════════════════════════════════════════════════════
// 3. tolerantParse — 截断 JSON（核心修复场景）
// ════════════════════════════════════════════════════════════════════
console.log('\n📦 [3] tolerantParse — 截断 JSON（未闭合字符串 / 括号）\n');

test('字符串在值中间截断', () => {
    // 模拟：网络中断，"content" 字段值只传了一半
    const truncated = '{"tool":"Write","parameters":{"content":"# Accrual Backfill Start Date Implementation Plan\\n\\n> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.\\n\\n**Goal:** Add an optional `backfillStartDate` parameter to the company-level accrual recalculate feature, allowing admins to specify a';
    const r = tolerantParse(truncated);
    // 能解析出来就行，content 可能被截断但 tool 字段存在
    assertEqual(r.tool, 'Write');
    assert(r.parameters !== undefined);
});

test('只缺少最后的 }}', () => {
    const truncated = '{"tool":"Read","parameters":{"file_path":"/Users/rain/project/src/index.ts"';
    const r = tolerantParse(truncated);
    assertEqual(r.tool, 'Read');
});

test('只缺少最后的 }', () => {
    const truncated = '{"name":"Bash","input":{"command":"ls -la"}';
    const r = tolerantParse(truncated);
    assertEqual(r.name, 'Bash');
});

test('嵌套对象截断', () => {
    const truncated = '{"tool":"Write","parameters":{"path":"a.ts","content":"export function foo() {\n  return 42;\n}';
    const r = tolerantParse(truncated);
    assertEqual(r.tool, 'Write');
});

test('带尾部逗号', () => {
    const withComma = '{"tool":"Read","parameters":{"path":"/foo",},}';
    const r = tolerantParse(withComma);
    assertEqual(r.tool, 'Read');
});

test('模拟 issue #13 原始错误 — position 813 截断', () => {
    // 模拟一个约813字节的 content 字段在字符串中间截断
    const longContent = 'A'.repeat(700);
    const truncated = `{"tool":"Write","parameters":{"file_path":"/docs/plan.md","content":"${longContent}`;
    const r = tolerantParse(truncated);
    assertEqual(r.tool, 'Write');
    // content 字段值可能被截断，但整体 JSON 应当能解析
    assert(typeof r.parameters.content === 'string', 'content 应为字符串');
});

// ════════════════════════════════════════════════════════════════════
// 4. parseToolCalls — 完整 ```json action 块
// ════════════════════════════════════════════════════════════════════
console.log('\n📦 [4] parseToolCalls — 完整代码块\n');

test('单个工具调用块 (tool 字段)', () => {
    const text = `I'll read the file now.

\`\`\`json action
{
  "tool": "Read",
  "parameters": {
    "file_path": "src/index.ts"
  }
}
\`\`\``;
    const { toolCalls, cleanText } = parseToolCalls(text);
    assertEqual(toolCalls.length, 1);
    assertEqual(toolCalls[0].name, 'Read');
    assertEqual(toolCalls[0].arguments.file_path, 'src/index.ts');
    assert(!cleanText.includes('```'), '代码块应被移除');
});

test('单个工具调用块 (name 字段)', () => {
    const text = `\`\`\`json action
{"name":"Bash","input":{"command":"npm run build"}}
\`\`\``;
    const { toolCalls } = parseToolCalls(text);
    assertEqual(toolCalls.length, 1);
    assertEqual(toolCalls[0].name, 'Bash');
    assertEqual(toolCalls[0].arguments.command, 'npm run build');
});

test('多个连续工具调用块', () => {
    const text = `\`\`\`json action
{"tool":"Read","parameters":{"file_path":"a.ts"}}
\`\`\`

\`\`\`json action
{"tool":"Write","parameters":{"file_path":"b.ts","content":"hello"}}
\`\`\``;
    const { toolCalls } = parseToolCalls(text);
    assertEqual(toolCalls.length, 2);
    assertEqual(toolCalls[0].name, 'Read');
    assertEqual(toolCalls[1].name, 'Write');
});

test('工具调用前有解释文本', () => {
    const text = `Let me first read the existing file to understand the structure.

\`\`\`json action
{"tool":"Read","parameters":{"file_path":"src/handler.ts"}}
\`\`\``;
    const { toolCalls, cleanText } = parseToolCalls(text);
    assertEqual(toolCalls.length, 1);
    assert(cleanText.includes('Let me first read'), '解释文本应保留');
});

test('不含工具调用的纯文本', () => {
    const text = 'Here is the answer: 42. No tool calls needed.';
    const { toolCalls, cleanText } = parseToolCalls(text);
    assertEqual(toolCalls.length, 0);
    assertEqual(cleanText, text);
});

test('json 块但不是 tool call（普通 json）', () => {
    const text = `Here is an example:
\`\`\`json
{"key":"value","count":42}
\`\`\``;
    const { toolCalls } = parseToolCalls(text);
    assertEqual(toolCalls.length, 0, '无 tool/name 字段的 JSON 不应被识别为工具调用');
});

// ════════════════════════════════════════════════════════════════════
// 5. 截断场景下的 parseToolCalls
// ════════════════════════════════════════════════════════════════════
console.log('\n📦 [5] parseToolCalls — 截断场景\n');

test('代码块内容被流中断（block 完整但 JSON 截断）', () => {
    // 完整的 ``` 包裹，但 JSON 内容被截断
    const text = `\`\`\`json action
{"tool":"Write","parameters":{"file_path":"/docs/plan.md","content":"# Plan\n\nThis is a very long document that got cut at position 813 in the strea
\`\`\``;
    const { toolCalls } = parseToolCalls(text);
    // 应当能解析出工具调用（即使 content 被截断）
    assertEqual(toolCalls.length, 1);
    assertEqual(toolCalls[0].name, 'Write');
    console.log(`    → 解析出的 content 前30字符: "${String(toolCalls[0].arguments.content).substring(0, 30)}..."`);
});

test('普通代码块标签也能识别工具对象', () => {
    const text = `\`\`\`tool
{"tool":"Read","parameters":{"file_path":"src/index.ts"}}
\`\`\``;
    const { toolCalls } = parseToolCalls(text);
    assertEqual(toolCalls.length, 1);
    assertEqual(toolCalls[0].name, 'Read');
});

test('编号列表中的工具对象可识别', () => {
    const text = `1. {"tool":"Read","parameters":{"file_path":"src/index.ts"}}`;
    const { toolCalls, cleanText } = parseToolCalls(text);
    assertEqual(toolCalls.length, 1);
    assertEqual(toolCalls[0].name, 'Read');
    assertEqual(cleanText, '');
});

test('引用块中的多行工具对象可识别', () => {
    const text = `> {
>   "tool": "Read",
>   "parameters": {
>     "file_path": "src/handler.ts"
>   }
> }`;
    const { toolCalls } = parseToolCalls(text);
    assertEqual(toolCalls.length, 1);
    assertEqual(toolCalls[0].arguments.file_path, 'src/handler.ts');
});

test('同一段 prose 中多个 inline 工具对象可分离', () => {
    const text = `First {"tool":"Read","parameters":{"file_path":"a.ts"}} then {"tool":"Bash","parameters":{"command":"ls"}}`;
    const { toolCalls, cleanText } = parseToolCalls(text);
    assertEqual(toolCalls.length, 2);
    assertEqual(toolCalls[0].name, 'Read');
    assertEqual(toolCalls[1].name, 'Bash');
    assert(cleanText.includes('First'), '普通说明文本应保留');
});

test('未闭合的 inline 工具对象也会触发恢复', () => {
    const text = `Use this {"tool":"Write","parameters":{"file_path":"a.ts","content":"hello`;
    const { toolCalls } = parseToolCalls(text);
    assertEqual(toolCalls.length, 1);
    assertEqual(toolCalls[0].name, 'Write');
});

test('超长 inline 工具对象不依赖正则长度限制', () => {
    const longContent = 'A'.repeat(9000);
    const text = `Result: {"tool":"Write","parameters":{"file_path":"big.md","content":"${longContent}"}}`;
    const { toolCalls } = parseToolCalls(text);
    assertEqual(toolCalls.length, 1);
    assertEqual(toolCalls[0].name, 'Write');
});

test('畸形 question json action 不会拆成多个工具调用，也不会把半截块留在正文', () => {
    const text = `Before
json action
{
  "tool": "question",
  "parameters": {
    "questions": [
      {
        "question": "Q",
        "header": "H",
        "options":
          {
            "label": "A",
            "description": "AA"
          },
          {
            "label": "B",
            "description": "BB"
          }
      }
    ]
  }
}
After`;
    const { toolCalls, cleanText } = parseToolCalls(text);
    assertEqual(toolCalls.length, 0);
    assert(cleanText.includes('Before'), '前置正文应保留');
    assert(cleanText.includes('After'), '后置正文应保留');
    assert(!cleanText.includes('"tool": "question"'), '坏掉的 action 块不应残留在正文');
    assert(!cleanText.includes('"options"'), '畸形参数片段不应残留在正文');
});

test('正文中的 json action 非工具示例不会被误删', () => {
    const text = `The docs mention json action {"foo":"bar"} as an example.`;
    const { toolCalls, cleanText } = parseToolCalls(text);
    assertEqual(toolCalls.length, 0);
    assertEqual(cleanText, text);
});

test('单引号风格的 inline 工具调用也能恢复', () => {
    const text = `json action {'tool':'Read','parameters':{'file_path':'src/index.ts'}}`;
    const { toolCalls, cleanText } = parseToolCalls(text);
    assertEqual(toolCalls.length, 1);
    assertEqual(toolCalls[0].name, 'Read');
    assertEqual(toolCalls[0].arguments.file_path, 'src/index.ts');
    assertEqual(cleanText, '');
});

test('ask_followup_question 的 options 必须是字符串数组', () => {
    const text = `{"tool":"ask_followup_question","parameters":{"question":"继续吗？","options":["继续",123]}}`;
    const { toolCalls, cleanText } = parseToolCalls(text);
    assertEqual(toolCalls.length, 0);
    assertEqual(cleanText, '');
});

test('前置花括号噪声不会吞掉后续 json action', () => {
    const text = `I apologize — I am Prometheus, the planning consultant.
{.*get' backend/src/CRM.Domain/Entities/BaseEntity.cs && ls backend/src/CRM.Domain/Enums/", "description": "Check current state of Task 1 files" } }











\`\`\`
\`\`\`json action
{"tool":"Read","parameters":{"path":"src/index.ts"}}
\`\`\``;
    const { toolCalls, cleanText } = parseToolCalls(text);
    assertEqual(toolCalls.length, 1);
    assertEqual(toolCalls[0].name, 'Read');
    assert(cleanText.includes('Prometheus'), '前置说明文本应保留');
});

test('hasToolCalls 与增强后的 inline 识别保持一致', () => {
    const text = `1. {"tool":"Read","parameters":{"file_path":"src/index.ts"}}`;
    assertEqual(hasToolCalls(text), true);
});

test('普通 json 代码块不会让 hasToolCalls 误报', () => {
    const text = `\`\`\`json
{"note":"example"}
\`\`\``;
    assertEqual(hasToolCalls(text), false);
});

// ════════════════════════════════════════════════════════════════════
// 汇总
// ════════════════════════════════════════════════════════════════════
console.log('\n' + '═'.repeat(55));
console.log(`  结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
console.log('═'.repeat(55) + '\n');

if (failed > 0) process.exit(1);
