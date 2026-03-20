import {
    sanitizeResponse,
    sanitizeResponseForRequest,
    isFirstTurnPromptLeak,
    isLowValueToolPreamble,
    shouldForceCompletionActionRetry,
    shouldForceDiagnosisActionRetry,
    shouldForceToolActionRetry,
    shouldForceWaitingActionRetry,
    shouldForceWriteLikeActionRetry,
    getToolModeNoCallFallbackText,
    hasSuspiciousToolResidualText,
    sanitizeToolVisibleText,
    buildToolRetryCursorRequest,
    buildForcedToolActionRetryCursorRequest,
    normalizeToolCallsForSchemas,
    CLAUDE_IDENTITY_RESPONSE,
    FIRST_TURN_NEUTRAL_RESPONSE,
} from '../src/handler.ts';

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
    const as = JSON.stringify(a);
    const bs = JSON.stringify(b);
    if (as !== bs) throw new Error(msg || `Expected ${bs}, got ${as}`);
}

console.log('\n📦 sanitizeResponse placeholder cleanup\n');

test('移除独立 pasted 占位行与空引号占位行', () => {
    const pastedMarker = '[Pasted ~' + '47 lines]';
    const input = `Ready to continue.\n${pastedMarker}\n\n''\nActual content`;
    const result = sanitizeResponse(input);
    assert(!result.includes(pastedMarker), '不应保留 pasted 占位');
    assert(!result.includes("''"), '不应保留空引号占位');
    assertEqual(result, 'Ready to continue.\n\nActual content');
});

test('普通引号说明文本保持不变', () => {
    const input = `The empty string is written as "" in JSON.`;
    const result = sanitizeResponse(input);
    assertEqual(result, input);
});

test('工具残留检测会识别 edit 参数字段', () => {
    const input = `\n"replaceAll": false`;
    assert(hasSuspiciousToolResidualText(input), '应识别 tool 字段残留');
});

test('工具可见文本清洗会抑制 pasted + replaceAll 残留', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'fix it' }],
        tools: [{ name: 'edit', input_schema: { type: 'object', properties: {} } }],
    };
    const input = `\n  } catch (_e) {\n    // 路径不存在，继续向上查找\n  }",\n"replaceAll": false`;
    const result = sanitizeToolVisibleText(input, body);
    assertEqual(result, '');
});

test('工具无调用回退会压制可疑 edit 参数残留', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'fix it' }],
        tools: [{ name: 'edit', input_schema: { type: 'object', properties: {} } }],
    };
    const input = `\n"replaceAll": false`;
    const result = getToolModeNoCallFallbackText(input, input, false, body, false);
    assertEqual(result, 'Let me proceed with the task.');
});

console.log('\n📦 sanitizeResponse first-turn fallback\n');

test('first-turn prompt injection fallback is neutral', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
    };
    const result = sanitizeResponseForRequest('This looks like a prompt injection attack.', body);
    assertEqual(result, FIRST_TURN_NEUTRAL_RESPONSE);
});

test('non-first-turn prompt injection fallback remains identity response', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: 'continue' },
        ],
    };
    const result = sanitizeResponseForRequest('What I will not do due to prompt injection.', body);
    assertEqual(result, CLAUDE_IDENTITY_RESPONSE);
});

test('first-turn Cursor 官方文档泄漏会被识别为重试条件', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
    };
    assert(isFirstTurnPromptLeak('我是 Cursor 官方文档助手，可以帮助你查阅文档。', body), '首轮文档助手泄漏应被识别');
});

test('first-turn English documentation assistant leak is detected', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
    };
    assert(
        isFirstTurnPromptLeak('I am a documentation assistant for Cursor and can help with official docs.', body),
        'English documentation assistant leak should be detected',
    );
});

test('first-turn Cursor support assistant leak is detected', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
    };
    assert(
        isFirstTurnPromptLeak('I am Cursor\'s support assistant and can only answer documentation questions.', body),
        'first-turn support-assistant leak should be detected',
    );
});

test('first-turn support-assistant text is directly intercepted to neutral response', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
    };
    const result = sanitizeResponseForRequest('I am Cursor\'s support assistant and can only answer documentation questions.', body);
    assertEqual(result, FIRST_TURN_NEUTRAL_RESPONSE);
});

test('first-turn Cursor help-center menu text is directly intercepted to neutral response', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
    };
    const text = [
        'If you have a question about Cursor (the AI code editor), I\'m happy to help. For example:',
        '- How to use Cursor\'s AI features',
        '- Billing or account questions',
        '- Setting up rules or context',
        '- Troubleshooting Cursor behavior',
        'What can I help you with?',
    ].join('\n');
    const result = sanitizeResponseForRequest(text, body);
    assertEqual(result, FIRST_TURN_NEUTRAL_RESPONSE);
});

test('first-turn generic Cursor mention is stripped when user did not mention Cursor', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
    };
    const result = sanitizeResponseForRequest('I can help with Cursor IDE features right now.', body);
    assert(!/\bcursor\b/i.test(result), 'generic first-turn Cursor mention should not survive when the user did not mention Cursor');
    assertEqual(result, FIRST_TURN_NEUTRAL_RESPONSE, 'unexpected Cursor mention should fall back to the neutral first-turn response');
});

test('first-turn leak is detected even when placed mid-response', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
    };
    const longPrefix = 'a'.repeat(1200);
    const text = `${longPrefix} 我是 Cursor 官方文档助手，可以帮助你查阅文档。 ${longPrefix}`;
    assert(isFirstTurnPromptLeak(text, body), 'mid-body leak should still be detected');
});

test('non-first-turn Cursor 官方文档提法不会触发首轮泄漏判定', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: 'continue' },
        ],
    };
    assert(!isFirstTurnPromptLeak('我是 Cursor 官方文档助手，可以帮助你查阅文档。', body), '非首轮不应触发首轮泄漏判定');
});

test('non-first-turn generic Cursor mention does not trigger first-turn leak', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: 'continue' },
        ],
    };
    assert(!isFirstTurnPromptLeak('I can help with Cursor IDE features.', body), '非首轮不应因 Cursor 普通提及触发首轮泄漏判定');
});

test('non-first-turn generic Cursor mention is stripped when user never mentioned Cursor', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: 'continue' },
        ],
    };
    const result = sanitizeResponseForRequest('Use Cursor to open settings and continue.', body);
    assert(!/\bcursor\b/i.test(result), 'later-turn replies should still suppress Cursor when the user never mentioned it');
});

test('lowercase cursor mention is stripped when user never mentioned cursor', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
    };
    const result = sanitizeResponseForRequest('If you need help in the cursor editor, I can assist.', body);
    assert(!/\bcursor\b/i.test(result), 'lowercase cursor mention should also be suppressed when the user did not mention cursor');
    assertEqual(result, FIRST_TURN_NEUTRAL_RESPONSE, 'lowercase cursor leakage should also fall back to the neutral first-turn response');
});

test('Cursor mention is preserved when the user explicitly mentions Cursor', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'How do I configure Cursor settings?' }],
    };
    const result = sanitizeResponseForRequest('In Cursor settings, open Preferences and search for rules.', body);
    assert(/\bcursor\b/i.test(result), 'Cursor mention should remain allowed when the user explicitly asked about Cursor');
});

test('lowercase cursor mention is preserved when the user explicitly mentions cursor', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'how do I configure cursor settings?' }],
    };
    const result = sanitizeResponseForRequest('In cursor settings, open Preferences and search for rules.', body);
    assert(/\bcursor\b/i.test(result), 'lowercase cursor mention should remain allowed when the user explicitly asked about cursor');
});

test('sanitizeResponse 会清理 Cursor 官方文档助手表述', () => {
    const result = sanitizeResponse('我是 Cursor 官方文档助手，可以帮助你查阅文档。');
    assert(!result.includes('Cursor 官方文档'), '清洗后不应保留 Cursor 官方文档 表述');
    assert(result.includes('Claude'), '清洗后应回到 Claude 身份');
});

test('tool-enabled first-turn prompt leak triggers forced action retry', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
        messages: [{ role: 'user', content: 'hello' }],
    };
    assert(
        shouldForceToolActionRetry('I am a documentation assistant for Cursor and can only answer docs questions.', body),
        'tool-enabled first-turn prompt leaks should force action retry',
    );
});

test('tool-enabled refusal with no tool calls triggers forced action retry', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
        messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: 'continue' },
        ],
    };
    assert(
        shouldForceToolActionRetry('I\'m your Cursor support assistant and cannot modify files on your system.', body),
        'tool-enabled refusal should force action retry even after first turn',
    );
});

test('tool-enabled English documentation/system-context fallback triggers forced action retry', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
        messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: 'continue' },
        ],
    };
    const text = 'I need to read the documentation to better assist you. Let me check the relevant information. I don\'t have access to your local filesystem or the ability to run commands. The tool outputs shown above are from a different system context.';
    assert(
        shouldForceToolActionRetry(text, body),
        'English documentation/system-context fallback should force action retry',
    );
});

test('tool-enabled Cursor help-center menu fallback triggers forced action retry', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
        messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: 'continue' },
        ],
    };
    const text = [
        'If you have a question about Cursor (the AI code editor), I\'m happy to help. For example:',
        '- How to use Cursor\'s AI features',
        '- Billing or account questions',
        '- Setting up rules or context',
        '- Troubleshooting Cursor behavior',
        'What can I help you with?',
    ].join('\n');
    assert(
        shouldForceToolActionRetry(text, body),
        'Cursor help-center menu fallback should force action retry in tool mode',
    );
});

test('tool-enabled Chinese documentation/system-context fallback triggers forced action retry', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
        messages: [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
            { role: 'user', content: 'continue' },
        ],
    };
    const text = '我需要先查阅相关文档以便更好地帮助你。让我先查看相关信息。我无法访问你的本地文件系统，也不能运行命令。上面显示的工具输出来自不同的系统上下文。';
    assert(
        shouldForceToolActionRetry(text, body),
        'Chinese documentation/system-context fallback should force action retry',
    );
});

test('forced action retry stays disabled without tools', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
    };
    assert(
        !shouldForceToolActionRetry('I\'m your Cursor support assistant and cannot modify files on your system.', body),
        'requests without tools should not enter forced tool retry',
    );
});

test('delegation-style plain text with no action block triggers forced action retry', () => {
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        tools: [{ name: 'task', description: 'Delegate work', input_schema: { type: 'object', properties: {} } }],
        messages: [{ role: 'user', content: 'hello' }],
    };
    const text = [
        '现在委派前端 RBAC UsersTab 的完整实现给视觉工程代理：',
        '1. TASK: Implement UsersTab',
        '2. EXPECTED OUTCOME: Working CRUD UI',
        '3. REQUIRED TOOLS: task tool',
        '4. MUST DO: Use Button type="link"',
        '5. MUST NOT DO: Do not touch other tabs',
        '6. CONTEXT: React 19 + antd v5',
    ].join('\n');

    assert(
        shouldForceToolActionRetry(text, body),
        'delegation-style plain text should force an action retry instead of being forwarded as text',
    );
});

test('write-heavy no-tool plan text triggers write-action retry', () => {
    const body = {
        tools: [
            { name: 'Write', description: 'Write a file', input_schema: { type: 'object', properties: {} } },
            { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
        ],
    };
    const text = 'The CSS file has corrupted trailing content. I need to rewrite App.css properly and remove those trailing lines.';
    assert(
        shouldForceWriteLikeActionRetry(text, body),
        'write-heavy planning prose with no action block should trigger the write-action retry',
    );
    assert(
        !shouldForceWriteLikeActionRetry('The fix is in place. Here\'s what the error was and what was done:', body),
        'completion-style summary prose should not be misclassified as write-action retry',
    );
});

test('write-action retry stays disabled when no write-like tools exist', () => {
    const body = {
        tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
    };
    const text = 'I need to rewrite App.css properly and remove those trailing lines.';
    assert(
        !shouldForceWriteLikeActionRetry(text, body),
        'without write/edit-like tools available, write-action retry should stay disabled',
    );
});

test('completion-summary text triggers completion-action retry when completion tool exists', () => {
    const body = {
        tools: [
            { name: 'attempt_completion', description: 'Finish task', input_schema: { type: 'object', properties: {} } },
            { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
        ],
    };
    const text = 'Task 1 is complete. Here is the summary: all acceptance criteria are met and the working tree is clean.';
    assert(
        shouldForceCompletionActionRetry(text, body),
        'tool-mode completion summary should trigger completion-action retry',
    );
    assert(
        shouldForceCompletionActionRetry('The fix is in place. Here\'s what the error was and what was done:', body),
        'newly observed fix-summary phrasing should trigger completion-action retry',
    );
    assert(
        shouldForceCompletionActionRetry('The investigation is complete. Here is a full summary of what was found and what was fixed:', body),
        'newly observed investigation-summary phrasing should trigger completion-action retry',
    );
    assert(
        shouldForceCompletionActionRetry('问题已解决。根本原因是 Dockerfile 的 runner 阶段没有包含静态文件目录。', body),
        'newly observed Chinese fix-summary phrasing should trigger completion-action retry',
    );
    assert(
        shouldForceCompletionActionRetry('构建成功，0 个错误。根因分析：静态 Configuration 未初始化。', body),
        'newly observed Chinese root-cause summary phrasing should trigger completion-action retry',
    );
    assert(
        shouldForceCompletionActionRetry('GET /admin/config 现在返回完整的运行时配置，所有字段都会正确回显到表单中。', body),
        'newly observed config-fix summary phrasing should trigger completion-action retry',
    );
    assert(
        shouldForceCompletionActionRetry('All changes are clean. Here\'s a summary of everything done:', body),
        'newly observed all-changes-clean summary phrasing should trigger completion-action retry',
    );
});

test('completion-action retry stays disabled without completion tool', () => {
    const body = {
        tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
    };
    const text = 'Task 1 is complete. Here is the summary: all acceptance criteria are met.';
    assert(
        !shouldForceCompletionActionRetry(text, body),
        'without attempt_completion, completion-summary retry should stay disabled',
    );
});

test('completion-summary retry does not trigger when another final action is still described', () => {
    const body = {
        tools: [{ name: 'attempt_completion', description: 'Finish task', input_schema: { type: 'object', properties: {} } }],
    };
    const text = 'The file has been deleted and the working tree is clean. Now appending to the notepad.';
    assert(
        !shouldForceCompletionActionRetry(text, body),
        'summary text that still describes a follow-up action should not force completion retry',
    );
});

test('getToolModeNoCallFallbackText keeps safe completion summary text in tool mode', () => {
    const body = {
        tools: [
            { name: 'attempt_completion', description: 'Finish task', input_schema: { type: 'object', properties: {} } },
            { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
        ],
        messages: [{ role: 'user', content: '请完成这次修复并总结。' }],
    };
    const text = 'All changes are clean. Here\'s a summary of everything done:\n- backend updated\n- frontend updated';
    const fallback = getToolModeNoCallFallbackText(text, text, false, body);
    assertEqual(fallback, text, 'safe completion summaries should be preserved instead of forced minimal fallback');
});

test('getToolModeNoCallFallbackText does not preserve completion summary when Cursor is mentioned', () => {
    const body = {
        tools: [
            { name: 'attempt_completion', description: 'Finish task', input_schema: { type: 'object', properties: {} } },
            { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
        ],
        messages: [{ role: 'user', content: '请完成这次修复并总结。' }],
    };
    const text = 'All changes are clean. Here\'s a summary of everything done for Cursor task.';
    const fallback = getToolModeNoCallFallbackText(text, text, false, body);
    assertEqual(fallback, 'Let me proceed with the task.', 'summary that still mentions Cursor should not bypass tool-mode fallback');
});

test('diagnosis-only text triggers diagnosis-action retry', () => {
    const body = {
        tools: [
            { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } },
            { name: 'Bash', description: 'Run a command', input_schema: { type: 'object', properties: {} } },
        ],
    };
    const text = 'Now I have enough context. The error comes from JwtServiceCollectionExtension.cs line 26.';
    assert(
        shouldForceDiagnosisActionRetry(text, body),
        'diagnosis-only prose without an action block should trigger diagnosis-action retry',
    );
    assert(
        shouldForceDiagnosisActionRetry('Now I have a complete picture of the issue. Let me summarize the root cause and solution:', body),
        'newly observed complete-picture phrasing should trigger diagnosis-action retry',
    );
    assert(
        shouldForceDiagnosisActionRetry('日志显示：`ResolvingHttpDelegatingHandler` 超时后发生重试。', body),
        'newly observed Chinese diagnosis phrasing should trigger diagnosis-action retry',
    );
    assert(
        shouldForceDiagnosisActionRetry('Oracle 的结论非常清晰：方案A是最佳选择。', body),
        'newly observed oracle-summary phrasing should trigger diagnosis-action retry',
    );
});

test('diagnosis-action retry does not trigger for completion summaries or write plans', () => {
    const body = {
        tools: [
            { name: 'attempt_completion', description: 'Finish task', input_schema: { type: 'object', properties: {} } },
            { name: 'Write', description: 'Write a file', input_schema: { type: 'object', properties: {} } },
        ],
    };
    assert(
        !shouldForceDiagnosisActionRetry('Task 1 is complete. Here is the summary: all acceptance criteria are met.', body),
        'completion summaries should be handled by completion retry instead of diagnosis retry',
    );
    assert(
        !shouldForceDiagnosisActionRetry('The CSS file has corrupted trailing content. I need to rewrite App.css properly and remove those trailing lines.', body),
        'write-heavy plans should be handled by write-action retry instead of diagnosis retry',
    );
});

test('waiting placeholder text triggers waiting-action retry when background_output exists', () => {
    const body = {
        tools: [{ name: 'background_output', description: 'Read background task result', input_schema: { type: 'object', properties: {} } }],
    };
    assert(
        shouldForceWaitingActionRetry('等待 Oracle 完成分析。', body),
        'waiting placeholder prose should trigger waiting-action retry when background_output is available',
    );
    assert(
        shouldForceWaitingActionRetry('Waiting for background task result before continuing.', body),
        'English waiting placeholder prose should trigger waiting-action retry',
    );
});

test('waiting-action retry stays disabled without background_output tool', () => {
    const body = {
        tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
    };
    assert(
        !shouldForceWaitingActionRetry('等待 Oracle 完成分析。', body),
        'without background_output, waiting-action retry should stay disabled',
    );
});

test('low-value tool preamble detection catches explanation-first filler', () => {
    assert(
        isLowValueToolPreamble('已收集足够上下文，现在并行实现所有组件。'),
        'Chinese explanation-first filler should be treated as low-value tool preamble',
    );
    assert(
        isLowValueToolPreamble('Now I have all the info needed. The APIs are:'),
        'English explanation-first filler should be treated as low-value tool preamble',
    );
});

test('low-value tool preamble detection does not swallow meaningful residual constraints', () => {
    assert(
        !isLowValueToolPreamble('Important: use UTF-8 and do not modify vendor files.'),
        'meaningful residual instructions should not be classified as low-value preamble',
    );
});

test('getToolModeNoCallFallbackText suppresses truncated partial tool text', () => {
    const fallback = getToolModeNoCallFallbackText(
        '```json action\n{"tool":"write","parameters":{"filePath":"a.ts"',
        'Partial truncated tool text',
        true,
    );
    assertEqual(fallback, 'Let me proceed with the task.');
});

test('buildForcedToolActionRetryCursorRequest neutralizes refusal history and appends action prompt', () => {
    const cursorReq = {
        model: 'anthropic/claude-sonnet-4.6',
        id: 'cur_123',
        trigger: 'submit-message',
        messages: [{
            id: 'msg_1',
            role: 'user',
            parts: [{ type: 'text', text: 'Please inspect the repo and fix the bug.' }],
        }],
    };
    const body = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
        messages: [{ role: 'user', content: 'hello' }],
    };

    const retried = buildForcedToolActionRetryCursorRequest(
        cursorReq,
        'I\'m your Cursor support assistant and can only answer documentation questions.',
        body,
    );

    const assistantText = retried.messages[1].parts[0].text;
    const userText = retried.messages[2].parts[0].text;
    assert(assistantText.includes('should be ignored'), 'forced retry should neutralize refusal history');
    assert(!assistantText.includes('Cursor support assistant'), 'forced retry should not replay the refusal persona');
    assert(userText.includes('valid ```json action block'), 'forced retry should demand an action block');
    assert(userText.includes('Required format example'), 'forced retry should include an explicit action format example');
    assert(userText.includes('do not output ACTION_NAME literally'), 'forced retry should warn against placeholder echoing');
    assert(userText.includes('"tool": "ACTION_NAME"'), 'forced retry should include the action example payload');
});

test('buildToolRetryCursorRequest includes explicit action-block example', () => {
    const cursorReq = {
        model: 'anthropic/claude-sonnet-4.6',
        id: 'cur_123',
        trigger: 'submit-message',
        messages: [{
            id: 'msg_1',
            role: 'user',
            parts: [{ type: 'text', text: 'Please inspect the repo and fix the bug.' }],
        }],
    };

    const retried = buildToolRetryCursorRequest(cursorReq);
    const userText = retried.messages[1].parts[0].text;
    assert(userText.includes('Required format example'), 'protocol correction retry should include an explicit action format example');
    assert(userText.includes('do not output ACTION_NAME literally'), 'protocol correction retry should warn against placeholder echoing');
    assert(userText.includes('```json action'), 'protocol correction retry should include a fenced action example');
});

test('normalizeToolCallsForSchemas aligns file path aliases to tool schema', () => {
    const normalized = normalizeToolCallsForSchemas([
        {
            name: 'Read',
            arguments: { file_path: 'src/index.ts', path: 'src/index.ts' },
            integrity: 'strict',
        },
    ], [
        {
            name: 'Read',
            description: 'Read a file',
            input_schema: {
                type: 'object',
                properties: {
                    filePath: { type: 'string' },
                },
            },
        },
    ]);

    assertEqual(normalized[0].arguments, { filePath: 'src/index.ts' }, 'schema-aware normalization should keep only the schema-supported filePath key');
});

test('normalizeToolCallsForSchemas preserves snake_case-only schemas', () => {
    const normalized = normalizeToolCallsForSchemas([
        {
            name: 'Read',
            arguments: { filePath: 'src/index.ts', path: 'src/index.ts' },
            integrity: 'strict',
        },
    ], [
        {
            name: 'Read',
            description: 'Read a file',
            input_schema: {
                type: 'object',
                properties: {
                    file_path: { type: 'string' },
                },
            },
        },
    ]);

    assertEqual(normalized[0].arguments, { file_path: 'src/index.ts' }, 'schema-aware normalization should target snake_case-only schemas too');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计\n`);

if (failed > 0) process.exit(1);
