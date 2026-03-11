/**
 * 快速测试：上下文压缩 + tolerantParse 增强
 */

// ==================== 1. tolerantParse 测试 ====================

// 内联一个简化版 tolerantParse 进行测试
function tolerantParse(jsonStr: string): any {
    try { return JSON.parse(jsonStr); } catch {}

    let inString = false, escaped = false, fixed = '';
    const bracketStack: string[] = [];
    for (let i = 0; i < jsonStr.length; i++) {
        const char = jsonStr[i];
        if (char === '\\' && !escaped) { escaped = true; fixed += char; }
        else if (char === '"' && !escaped) { inString = !inString; fixed += char; escaped = false; }
        else {
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
            escaped = false;
        }
    }
    if (inString) fixed += '"';
    while (bracketStack.length > 0) fixed += bracketStack.pop();
    fixed = fixed.replace(/,\s*([}\]])/g, '$1');

    try { return JSON.parse(fixed); } catch (_e2) {
        const lastBrace = fixed.lastIndexOf('}');
        if (lastBrace > 0) { try { return JSON.parse(fixed.substring(0, lastBrace + 1)); } catch {} }

        // 第四层：正则兜底
        try {
            const toolMatch = jsonStr.match(/"(?:tool|name)"\s*:\s*"([^"]+)"/);
            if (toolMatch) {
                const toolName = toolMatch[1];
                const paramsMatch = jsonStr.match(/"(?:parameters|arguments|input)"\s*:\s*(\{[\s\S]*)/);
                let params: Record<string, unknown> = {};
                if (paramsMatch) {
                    const paramsStr = paramsMatch[1];
                    let depth = 0, end = -1, pInString = false, pEscaped = false;
                    for (let i = 0; i < paramsStr.length; i++) {
                        const c = paramsStr[i];
                        if (c === '\\' && !pEscaped) { pEscaped = true; continue; }
                        if (c === '"' && !pEscaped) { pInString = !pInString; }
                        if (!pInString) {
                            if (c === '{') depth++;
                            if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
                        }
                        pEscaped = false;
                    }
                    if (end > 0) {
                        const rawParams = paramsStr.substring(0, end + 1);
                        try { params = JSON.parse(rawParams); } catch {
                            const fieldRegex = /"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
                            let fm: RegExpExecArray | null = fieldRegex.exec(rawParams);
                            while (fm !== null) {
                                params[fm[1]] = fm[2].replace(/\\n/g, '\n').replace(/\\t/g, '\t');
                                fm = fieldRegex.exec(rawParams);
                            }
                        }
                    }
                }
                return { tool: toolName, parameters: params };
            }
        } catch {}
        throw _e2;
    }
}

// ==================== 运行测试 ====================

let passed = 0, failed = 0;
function assert(name: string, condition: boolean, detail?: string) {
    if (condition) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; console.log(`  ❌ ${name}${detail ? ': ' + detail : ''}`); }
}

console.log('\n=== tolerantParse 测试 ===');

// 正常 JSON
const t1 = tolerantParse('{"tool":"read_file","parameters":{"file_path":"src/index.ts"}}');
assert('正常 JSON', t1.tool === 'read_file' && t1.parameters.file_path === 'src/index.ts');

// 带裸换行符
const t2 = tolerantParse('{"tool":"write_file","parameters":{"content":"line1\nline2"}}');
assert('裸换行修复', t2.tool === 'write_file');

// 截断 JSON（未闭合）
const t3 = tolerantParse('{"tool":"bash","parameters":{"command":"ls -la');
assert('截断兜底', t3.tool === 'bash');

// 含未转义引号的代码内容（最重要的场景）
const badJson = `{
  "tool": "write_file",
  "parameters": {
    "file_path": "test.ts",
    "content": "const x = "hello"; console.log(x);"
  }
}`;
const t4 = tolerantParse(badJson);
assert('未转义引号 - 提取 tool 名', t4.tool === 'write_file');
assert('未转义引号 - 提取参数', Object.keys(t4.parameters).length > 0, `keys=${JSON.stringify(Object.keys(t4.parameters))}`);

// 尾部逗号
const t5 = tolerantParse('{"tool":"list_dir","parameters":{"path":"./",},}');
assert('尾部逗号修复', t5.tool === 'list_dir');

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===\n`);
process.exit(failed > 0 ? 1 : 0);
