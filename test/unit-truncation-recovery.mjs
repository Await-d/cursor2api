import {
    deduplicateContinuation,
    finalizeToolResponseForClient,
    getAnthropicToolStopReason,
    getOpenAIToolFinishReason,
    isTruncated,
    shouldRetryCompleteToolOutput,
    shouldRetryIncompleteToolOutput,
    shouldKeepPreviousToolResolution,
} from '../src/handler.ts';
import { hasToolCalls, parseToolCalls } from '../src/converter.ts';

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅  ${name}`);
        passed++;
    } catch (error) {
        console.error(`  ❌  ${name}`);
        console.error(`      ${error instanceof Error ? error.message : String(error)}`);
        failed++;
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);
    if (actualJson !== expectedJson) {
        throw new Error(message || `Expected ${expectedJson}, got ${actualJson}`);
    }
}

console.log('\n📦 truncation helpers\n');

test('isTruncated detects incomplete action block', () => {
    const truncated = '```json action\n{"tool":"Write","parameters":{"path":"a.txt"';
    assert(isTruncated(truncated), 'incomplete tool block should be considered truncated');
});

test('isTruncated ignores complete action block', () => {
    const complete = '```json action\n{"tool":"Write","parameters":{"path":"a.txt"}}\n```';
    assert(!isTruncated(complete), 'complete tool block should not be truncated');
});

test('isTruncated ignores complete inline action objects', () => {
    const inline = 'Take the next step with json action {"tool":"Read","parameters":{"path":"src/index.ts"}}';
    assert(!isTruncated(inline), 'complete inline action object should not be treated as truncated');
});

test('deduplicateContinuation removes overlapping prefix', () => {
    const existing = 'Line 1\nLine 2\nLine 3';
    const continuation = 'Line 2\nLine 3\nLine 4';
    assertEqual(deduplicateContinuation(existing, continuation), '\nLine 4');
});

test('truncated multi-call output still reports truncation after parsing one valid call', () => {
    const response = [
        '```json action',
        '{"tool":"Read","parameters":{"path":"a.txt"}}',
        '```',
        '```json action',
        '{"tool":"Write","parameters":{"path":"b.txt"',
    ].join('\n');

    const parsed = parseToolCalls(response);
    assert(parsed.toolCalls.some(call => call.name === 'Read'), 'first complete tool call should still parse');
    assert(parsed.toolCalls.some(call => call.name === 'Read' && call.integrity === 'strict'), 'complete tool call should be marked strict');
    assert(parsed.toolCalls.some(call => call.name === 'Write' && call.integrity === 'recovered'), 'truncated tool call should be marked recovered');
    assert(isTruncated(response), 'response should still be marked truncated when a later call is incomplete');
});

test('finalizeToolResponseForClient keeps only strict tool calls for truncated output', () => {
    const response = [
        '```json action',
        '{"tool":"Read","parameters":{"path":"a.txt"}}',
        '```',
        '```json action',
        '{"tool":"Write","parameters":{"path":"b.txt"',
    ].join('\n');

    const parsed = parseToolCalls(response);
    const finalized = finalizeToolResponseForClient(response, parsed);

    assert(finalized.stillTruncated, 'truncated tool response should remain marked truncated');
    assertEqual(finalized.toolCalls.map(call => call.name), ['Read']);
    assertEqual(finalized.cleanText, '');
    assertEqual(finalized.droppedRecoveredToolCalls, 1);
    assertEqual(getAnthropicToolStopReason(finalized), 'tool_use');
    assertEqual(getOpenAIToolFinishReason(finalized), 'tool_calls');
    assert(shouldRetryIncompleteToolOutput(finalized), 'truncated tool output should trigger another action-only retry');
});

test('finalizeToolResponseForClient drops recovered truncated write calls entirely', () => {
    const response = [
        '```json action',
        '{"tool":"Write","parameters":{"path":"plan.md","content":"hello world',
    ].join('\n');

    const parsed = parseToolCalls(response);
    const finalized = finalizeToolResponseForClient(response, parsed);

    assertEqual(parsed.toolCalls[0]?.integrity, 'recovered');
    assert(finalized.stillTruncated, 'single truncated write should remain marked truncated');
    assertEqual(finalized.toolCalls.length, 0);
    assertEqual(finalized.cleanText, '');
    assertEqual(finalized.droppedRecoveredToolCalls, 1);
    assertEqual(getAnthropicToolStopReason(finalized), 'max_tokens');
    assertEqual(getOpenAIToolFinishReason(finalized), 'length');
});

test('finalizeToolResponseForClient suppresses explanatory text for recovered-only truncated output', () => {
    const response = [
        'The file is severely corrupted with duplicates. I will rewrite it completely from scratch.',
        '```json action',
        '{"tool":"Write","parameters":{"path":"plan.md","content":"hello world',
    ].join('\n\n');

    const parsed = parseToolCalls(response);
    const finalized = finalizeToolResponseForClient(response, parsed);

    assertEqual(parsed.cleanText, 'The file is severely corrupted with duplicates. I will rewrite it completely from scratch.');
    assertEqual(finalized.toolCalls.length, 0);
    assertEqual(finalized.cleanText, '');
    assertEqual(getAnthropicToolStopReason(finalized), 'max_tokens');
});

test('finalizeToolResponseForClient drops low-value bash completion calls', () => {
    const response = [
        '```json action',
        '{"tool":"bash","parameters":{"command":"echo \'Done\'","description":"Done","timeout":3000}}',
        '```',
    ].join('\n');

    const parsed = parseToolCalls(response);
    const finalized = finalizeToolResponseForClient(response, parsed);
    assertEqual(parsed.toolCalls.length, 1);
    assertEqual(finalized.toolCalls.length, 0, 'low-value bash completion commands should not count as valid tool progress');
    assertEqual(finalized.cleanText, '', 'there is no visible clean text in this sample');
});

test('finalizeToolResponseForClient drops low-value bash completion variants', () => {
    const response = [
        '```json action',
        '{"tool":"bash","parameters":{"command":"echo \'Analysis complete\'","description":"Final message","timeout":3000}}',
        '```',
    ].join('\n');

    const parsed = parseToolCalls(response);
    const finalized = finalizeToolResponseForClient(response, parsed);
    assertEqual(finalized.toolCalls.length, 0, 'analysis-complete bash placeholders should also be dropped');
});

test('parseToolCalls prefers explicit json action over earlier brace noise', () => {
    const response = [
        'I apologize — I am Prometheus, the planning consultant.',
        '{.*get\' backend/src/CRM.Domain/Entities/BaseEntity.cs && ls backend/src/CRM.Domain/Enums/", "description": "Check current state of Task 1 files" } }',
        '```',
        '```json action',
        '{"tool":"Read","parameters":{"path":"src/index.ts"}}',
        '```',
    ].join('\n');

    const parsed = parseToolCalls(response);
    assertEqual(parsed.toolCalls.map(call => call.name), ['Read']);
    assertEqual(parsed.toolCalls[0]?.integrity, 'strict');
    assert(parsed.cleanText.includes('Prometheus'), 'leading prose should be preserved');
});

test('parseToolCalls normalizes common file argument aliases', () => {
    const response = [
        '```json action',
        '{"tool":"Read","parameters":{"file_path":"src/index.ts"}}',
        '```',
    ].join('\n');

    const parsed = parseToolCalls(response);
    assertEqual(parsed.toolCalls.length, 1);
    assertEqual(parsed.toolCalls[0]?.arguments.filePath, 'src/index.ts');
    assertEqual(parsed.toolCalls[0]?.arguments.path, 'src/index.ts');
});

test('parseToolCalls recovers task action blocks with multiline prompt and inner code fences', () => {
    const response = [
        'Before',
        '```json action',
        '{',
        '  "tool": "task",',
        '  "parameters": {',
        '    "category": "visual-engineering",',
        '    "description": "Implement UsersTab",',
        '    "load_skills": [],',
        '    "prompt": "现在委派前端 RBAC UsersTab 的完整实现给视觉工程代理。\\n- Use Button type="link" for 编辑/禁用。\\n- Preserve this block:\\n```ts\\nasync function createUser(data: { userName: string }): Promise<void>\\n```\\n- Endpoint: /rbac/users/{id}",',
        '    "run_in_background": false',
        '  }',
        '}',
        '```',
        'After',
    ].join('\n');

    const parsed = parseToolCalls(response);
    assertEqual(parsed.toolCalls.length, 1);
    assertEqual(parsed.toolCalls[0]?.name, 'task');
    assertEqual(parsed.toolCalls[0]?.arguments.category, 'visual-engineering');
    assertEqual(parsed.toolCalls[0]?.arguments.run_in_background, false);
    assertEqual(parsed.toolCalls[0]?.arguments.load_skills, []);
    assert(String(parsed.toolCalls[0]?.arguments.prompt).includes('type="link"'), 'prompt should preserve inner quotes');
    assert(String(parsed.toolCalls[0]?.arguments.prompt).includes('```ts'), 'prompt should preserve inner code fence content');
    assert(parsed.cleanText.includes('Before'), 'leading prose should remain in clean text');
    assert(parsed.cleanText.includes('After'), 'trailing prose should remain in clean text');
    assert(!parsed.cleanText.includes('visual-engineering'), 'task action payload should be removed from clean text');
});

test('task recovery does not overwrite top-level fields with prompt-embedded JSON snippets', () => {
    const response = [
        '```json action',
        '{',
        '  "tool": "task",',
        '  "parameters": {',
        '    "category": "visual-engineering",',
        '    "description": "Implement UsersTab",',
        '    "load_skills": ["frontend-design"],',
        '    "prompt": "Use this literal example in the delegated prompt: {\\"load_skills\\":[\\"wrong-skill\\"],\\"run_in_background\\":true}",',
        '    "run_in_background": false',
        '  }',
        '}','```',
    ].join('\n');

    const parsed = parseToolCalls(response);
    assertEqual(parsed.toolCalls.length, 1);
    assertEqual(parsed.toolCalls[0]?.arguments.load_skills, ['frontend-design']);
    assertEqual(parsed.toolCalls[0]?.arguments.run_in_background, false);
    assert(String(parsed.toolCalls[0]?.arguments.prompt).includes('wrong-skill'), 'prompt should retain embedded JSON example text');
});

test('parseToolCalls recovers inline task delegation objects preceded by prose', () => {
    const response = [
        '现在清楚了 login_ip_whitelist 和 login_attempt_logs 的表结构需求。并行实现后端 IP 白名单接口 + 前端两个配置页面：',
        '{',
        '  "tool": "task",',
        '  "parameters": {',
        '    "category": "visual-engineering",',
        '    "load_skills": ["ant-design", "vercel-react-best-practices"],',
        '    "description": "Frontend: IpWhitelistPage + ExemptUsersPage (reuse TargetsPage)",',
        '    "run_in_background": true,',
        '    "prompt": "1. TASK:\nImplement two admin settings pages.\n\n4. MUST DO:\n```ts\nasync function fetchIpWhitelist(): Promise<IpWhitelistDto[]>\n```\nUse Button type=\"link\"."',
        '  }',
        '}',
    ].join('\n');

    const parsed = parseToolCalls(response);
    assertEqual(parsed.toolCalls.length, 1);
    assertEqual(parsed.toolCalls[0]?.name, 'task');
    assertEqual(parsed.toolCalls[0]?.arguments.category, 'visual-engineering');
    assertEqual(parsed.toolCalls[0]?.arguments.load_skills, ['ant-design', 'vercel-react-best-practices']);
    assertEqual(parsed.toolCalls[0]?.arguments.run_in_background, true);
    assert(String(parsed.toolCalls[0]?.arguments.prompt).includes('```ts'), 'inline task prompt should preserve embedded fenced code');
    assert(parsed.cleanText.includes('表结构需求'), 'leading prose should remain');
    assert(!parsed.cleanText.includes('visual-engineering'), 'parsed inline task object should be removed from clean text');
});

test('parseToolCalls recovers write action with malformed long content payload', () => {
    const response = [
        '```json action',
        '{',
        '  "tool": "write",',
        '  "parameters": {',
        '    "filePath": "/tmp/demo.ts",',
        '    "content": "const title = "Runtime Log";\n```ts\nexport const demo = true\n```\n' + 'A'.repeat(180),
    ].join('\n');

    const parsed = parseToolCalls(response);
    assertEqual(parsed.toolCalls.length, 1);
    assertEqual(parsed.toolCalls[0]?.name, 'write');
    assertEqual(parsed.toolCalls[0]?.arguments.filePath, '/tmp/demo.ts');
    assert(String(parsed.toolCalls[0]?.arguments.content).includes('Runtime Log'), 'write recovery should preserve quoted content fragments');
    assert(String(parsed.toolCalls[0]?.arguments.content).includes('```ts'), 'write recovery should preserve embedded fenced code');
});

test('parseToolCalls recovers edit action with malformed replacement strings', () => {
    const response = [
        '```json action',
        '{',
        '  "tool": "edit",',
        '  "parameters": {',
        '    "filePath": "/tmp/demo.ts",',
        '    "oldString": "const count = 1;\nconsole.log(count);",',
        '    "newString": "const count = 2;\nconsole.log(\"updated\", count);',
    ].join('\n');

    const parsed = parseToolCalls(response);
    assertEqual(parsed.toolCalls.length, 1);
    assertEqual(parsed.toolCalls[0]?.name, 'edit');
    assertEqual(parsed.toolCalls[0]?.arguments.filePath, '/tmp/demo.ts');
    assert(String(parsed.toolCalls[0]?.arguments.oldString).includes('const count = 1'), 'edit recovery should preserve oldString');
    assert(String(parsed.toolCalls[0]?.arguments.newString).includes('updated'), 'edit recovery should preserve newString');
    assert(!String(parsed.toolCalls[0]?.arguments.newString).match(/\n\s*}\s*\n\s*}\s*$/), 'edit recovery should not append outer JSON braces to newString');
});

test('edit recovery does not stop oldString at field-like text inside the value', () => {
    const response = [
        '```json action',
        '{',
        '  "tool": "edit",',
        '  "parameters": {',
        '    "filePath": "/tmp/demo.ts",',
        '    "oldString": "literal sample: \", \\"newString\\": \\"fake\\"\nkeep this too",',
        '    "newString": "replacement"',
        '  }',
        '}',
        '```',
    ].join('\n');

    const parsed = parseToolCalls(response);
    assertEqual(parsed.toolCalls.length, 1);
    assert(String(parsed.toolCalls[0]?.arguments.oldString).includes('"newString": "fake"'), 'oldString should preserve field-like text instead of truncating early');
    assert(String(parsed.toolCalls[0]?.arguments.oldString).includes('keep this too'), 'oldString should preserve subsequent content');
});

test('edit cleaner recovered value strips trailing brace artifacts from oldString', () => {
    const response = [
        '```json action',
        '{',
        '  "tool": "edit",',
        '  "parameters": {',
        '    "filePath": "/tmp/demo.ts",',
        '    "oldString": "const a = 1\\nconsole.log(a)\\n}"',
        '    ,',
        '    "newString": "const a = 2"',
        '  }',
        '}',
        '```',
    ].join('\n');

    const parsed = parseToolCalls(response);
    assertEqual(parsed.toolCalls.length, 1);
    const oldString = String(parsed.toolCalls[0]?.arguments.oldString);
    assert(oldString.includes('console.log(a)'), 'oldString should preserve intended content');
    assert(!oldString.endsWith('}"\n}\n```'), 'oldString should not retain trailing structural suffix artifacts');
});

test('write recovery does not stop at content text that looks like another field', () => {
    const response = [
        '```json action',
        '{',
        '  "tool": "write",',
        '  "parameters": {',
        '    "filePath": "/tmp/demo.ts",',
        '    "content": "literal sample: \", \\"path\\": \\"fake.ts\\"\nsecond line\nreal ending starts here',
    ].join('\n');

    const parsed = parseToolCalls(response);
    assertEqual(parsed.toolCalls.length, 1);
    assert(String(parsed.toolCalls[0]?.arguments.content).includes('"path": "fake.ts"'), 'content should preserve field-like text instead of truncating early');
    assertEqual(parsed.toolCalls[0]?.arguments.filePath, '/tmp/demo.ts');
});

test('write recovery does not stop at content text containing quote-brace sequence', () => {
    const response = [
        '```json action',
        '{',
        '  "tool": "write",',
        '  "parameters": {',
        '    "filePath": "/tmp/demo.ts",',
        '    "content": "example with \"}\" inside string\nthen more content here',
    ].join('\n');

    const parsed = parseToolCalls(response);
    assertEqual(parsed.toolCalls.length, 1);
    assert(String(parsed.toolCalls[0]?.arguments.content).includes('"}" inside string'), 'content should preserve quote-brace text instead of truncating at end-object heuristic');
    assert(!String(parsed.toolCalls[0]?.arguments.content).match(/\n\s*}\s*\n\s*}\s*$/), 'write recovery should not append outer JSON braces to content');
});

test('write/edit cleaner recovered value overrides longer structural-suffix variant', () => {
    const response = [
        '```json action',
        '{',
        '  "tool": "edit",',
        '  "parameters": {',
        '    "filePath": "/tmp/demo.ts",',
        '    "oldString": "const a = 1",',
        '    "newString": "const a = 2\\nconsole.log(a)\\n}',
        '  }',
        '}',
        '```',
    ].join('\n');

    const parsed = parseToolCalls(response);
    assertEqual(parsed.toolCalls.length, 1);
    const newString = String(parsed.toolCalls[0]?.arguments.newString);
    assert(newString.includes('console.log(a)'), 'edit recovery should preserve meaningful replacement content');
    assert(!newString.endsWith('}\n}\n}'), 'cleaner recovered newString should replace structurally suffixed variant');
});

test('write/edit cleaner recovered value also strips trailing quote-only artifact lines', () => {
    const response = [
        '```json action',
        '{',
        '  "tool": "edit",',
        '  "parameters": {',
        '    "filePath": "/tmp/demo.ts",',
        '    "oldString": "const a = 1",',
        '    "newString": "const a = 2\\nconsole.log(a)\\n\"',
        '  }',
        '}',
        '```',
    ].join('\n');

    const parsed = parseToolCalls(response);
    assertEqual(parsed.toolCalls.length, 1);
    const newString = String(parsed.toolCalls[0]?.arguments.newString);
    assert(newString.includes('console.log(a)'), 'edit recovery should preserve intended content');
    assert(!newString.endsWith('\n"\n}\n}'), 'cleaner recovered value should drop trailing quote/braces artifact lines');
});

test('bash heredoc recovery does not append trailing JSON braces to command', () => {
    const response = [
        '```json action',
        '{',
        '  "tool": "bash",',
        '  "parameters": {',
        '    "command": "cat > /tmp/demo.ts <<\'EOF\'\\nconst value = 1\\nEOF',
        '  }',
        '}',
        '```',
    ].join('\n');

    const parsed = parseToolCalls(response);
    assertEqual(parsed.toolCalls.length, 1);
    const command = String(parsed.toolCalls[0]?.arguments.command);
    assert(command.includes("cat > /tmp/demo.ts <<'EOF'"), 'bash recovery should preserve heredoc command content');
    assert(!command.match(/\n\s*}\s*\n\s*}$/), 'bash command should not retain outer JSON braces at the end');
});

test('hasToolCalls ignores plain json fences without action signature', () => {
    const response = '```json\n{"note":"example"}\n```';
    assertEqual(hasToolCalls(response), false);
});

test('complete tool output does not trigger retry just because prose exists', () => {
    const response = [
        '已收集足够上下文，现在并行实现所有组件。',
        '```json action',
        '{"tool":"todowrite","parameters":{"todos":[{"content":"do work","status":"pending","priority":"high"}]}}',
        '```',
    ].join('\n');

    const parsed = parseToolCalls(response);
    const finalized = finalizeToolResponseForClient(response, parsed);
    assertEqual(finalized.toolCalls.length, 1);
    assert(!finalized.stillTruncated, 'complete tool output should not be marked truncated');
    assert(!shouldRetryCompleteToolOutput(finalized, parsed), 'complete tool output should not trigger full re-emit retry');
    assert(!shouldRetryIncompleteToolOutput(finalized), 'complete tool output should not trigger retry based on preamble text');
});

test('truncated tool output without residual text skips complete re-emit retry', () => {
    const response = [
        '```json action',
        '{"tool":"Read","parameters":{"filePath":"src/index.ts"}}',
        '```',
        '```json action',
        '{"tool":"Write","parameters":{"filePath":"src/next.ts"',
    ].join('\n');

    const parsed = parseToolCalls(response);
    const finalized = finalizeToolResponseForClient(response, parsed);
    assertEqual(finalized.cleanText, '');
    assert(!shouldRetryCompleteToolOutput(finalized, parsed), 'when no residual text remains, skip the full re-emit retry and go straight to action-only fallback');
});

test('truncated tool output with residual text prefers complete re-emit retry first', () => {
    const response = [
        'I found the issue and will now patch the file.',
        '```json action',
        '{"tool":"Read","parameters":{"filePath":"src/index.ts"}}',
        '```',
        '```json action',
        '{"tool":"Write","parameters":{"filePath":"src/next.ts"',
    ].join('\n');

    const parsed = parseToolCalls(response);
    const finalized = finalizeToolResponseForClient(response, parsed);
    assert(shouldRetryCompleteToolOutput(finalized, parsed), 'truncated tool output with residual text should prefer a complete re-emit retry before action-only fallback');
});

test('shouldKeepPreviousToolResolution preserves earlier complete tool calls when retry is worse', () => {
    const previous = {
        toolCalls: [
            { name: 'Read', arguments: { filePath: 'a.ts' }, integrity: 'strict' },
            { name: 'Bash', arguments: { command: 'npm run build' }, integrity: 'strict' },
        ],
        stillTruncated: true,
    };
    const next = {
        toolCalls: [{ name: 'Bash', arguments: { command: 'npm run build' }, integrity: 'strict' }],
        stillTruncated: false,
    };

    assert(
        shouldKeepPreviousToolResolution(previous, next),
        'retry result with fewer tool calls should not replace the earlier more complete tool set',
    );
});

test('isTruncated ignores long plain text without structural truncation', () => {
    const longPlainText = 'A'.repeat(2600);
    assert(!isTruncated(longPlainText), 'long plain text alone should not be marked truncated');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计\n`);

if (failed > 0) process.exit(1);
