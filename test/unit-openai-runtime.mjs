import { handleOpenAIChatCompletions } from '../src/openai-handler.ts';
import { FIRST_TURN_NEUTRAL_RESPONSE, MAX_REFUSAL_RETRIES } from '../src/handler.ts';

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
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

function createMockReq(body) {
    return {
        body,
        on() {},
        off() {},
    };
}

function createMockRes() {
    return {
        statusCode: 200,
        headers: null,
        jsonPayload: null,
        chunks: [],
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.jsonPayload = payload;
            return this;
        },
        writeHead(statusCode, headers) {
            this.statusCode = statusCode;
            this.headers = headers;
        },
        write(chunk) {
            this.chunks.push(String(chunk));
        },
        end() {},
        on() {},
        off() {},
    };
}

function buildCursorReq() {
    return {
        model: 'anthropic/claude-sonnet-4.6',
        id: 'cursor_req_openai_test',
        trigger: 'manual',
        messages: [
            {
                id: 'msg_1',
                role: 'user',
                parts: [{ type: 'text', text: 'Inspect src/openai-handler.ts and continue.' }],
            },
        ],
    };
}

function buildOpenAIToolBody(toolChoice = 'auto') {
    return {
        model: 'gpt-5',
        stream: false,
        messages: [{ role: 'user', content: 'Inspect src/openai-handler.ts and continue.' }],
        tools: [{
            type: 'function',
            function: {
                name: 'Read',
                description: 'Read a file',
                parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
        }],
        tool_choice: toolChoice,
    };
}

console.log('\n📦 openai runtime\n');

await test('non-stream OpenAI handler preserves original text when resolver marks preserve-original', async () => {
    const req = createMockReq(buildOpenAIToolBody('auto'));
    const res = createMockRes();
    const cursorReq = buildCursorReq();

    await handleOpenAIChatCompletions(req, res, {
        createAbortSignal: () => new AbortController().signal,
        convertToCursorRequest: async () => cursorReq,
        sendCursorRequestFull: async () => 'Initial raw text',
        sendCursorRequest: async () => {},
        resolveToolResponse: async () => ({
            fullText: 'Original plain-text status update.',
            toolCalls: [],
            cleanText: '',
            thinkingBlocks: [],
            stillTruncated: false,
            droppedRecoveredToolCalls: 0,
            preserveOriginalTextWithoutToolCall: true,
        }),
    });

    assert(res.statusCode === 200, `unexpected status: ${res.statusCode}`);
    assert(res.jsonPayload?.choices?.[0]?.message?.content === 'Original plain-text status update.', 'OpenAI runtime should surface preserved original text');
    assert(res.jsonPayload?.choices?.[0]?.finish_reason === 'stop', 'non-tool fallback should finish with stop');
});

await test('non-stream OpenAI handler keeps minimal fallback when tool_choice is required and no tool call exists', async () => {
    const req = createMockReq(buildOpenAIToolBody('required'));
    const res = createMockRes();
    const cursorReq = buildCursorReq();

    await handleOpenAIChatCompletions(req, res, {
        createAbortSignal: () => new AbortController().signal,
        convertToCursorRequest: async () => cursorReq,
        sendCursorRequestFull: async () => 'Initial raw text',
        sendCursorRequest: async () => {},
        resolveToolResponse: async () => ({
            fullText: '**当前状态总结：**\n- 已完成：Phase 1',
            toolCalls: [],
            cleanText: '**当前状态总结：**\n- 已完成：Phase 1',
            thinkingBlocks: [],
            stillTruncated: false,
            droppedRecoveredToolCalls: 0,
            preserveOriginalTextWithoutToolCall: false,
        }),
    });

    assert(res.statusCode === 200, `unexpected status: ${res.statusCode}`);
    assert(res.jsonPayload?.choices?.[0]?.message?.content === 'Let me proceed with the task.', 'required tool_choice should not accept text-only summary fallback');
    assert(res.jsonPayload?.choices?.[0]?.finish_reason === 'stop', 'no-tool fallback should still report stop');
});

await test('non-stream OpenAI handler strips unexpected Cursor mention when user did not mention Cursor', async () => {
    const req = createMockReq(buildOpenAIToolBody('auto'));
    const res = createMockRes();
    const cursorReq = buildCursorReq();

    await handleOpenAIChatCompletions(req, res, {
        createAbortSignal: () => new AbortController().signal,
        convertToCursorRequest: async () => cursorReq,
        sendCursorRequestFull: async () => 'Initial raw text',
        sendCursorRequest: async () => {},
        resolveToolResponse: async () => ({
            fullText: 'If you need help with something in the Cursor editor, I am happy to assist.',
            toolCalls: [],
            cleanText: 'If you need help with something in the Cursor editor, I am happy to assist.',
            thinkingBlocks: [],
            stillTruncated: false,
            droppedRecoveredToolCalls: 0,
            preserveOriginalTextWithoutToolCall: true,
        }),
    });

    const content = res.jsonPayload?.choices?.[0]?.message?.content || '';
    assert(!/\bcursor\b/i.test(content), 'OpenAI runtime should not emit Cursor when the user never mentioned it');
    assert(content === FIRST_TURN_NEUTRAL_RESPONSE, 'unexpected Cursor mention should fall back to the neutral visible response');
});

await test('non-stream OpenAI handler also strips unexpected lowercase cursor mention', async () => {
    const req = createMockReq(buildOpenAIToolBody('auto'));
    const res = createMockRes();
    const cursorReq = buildCursorReq();

    await handleOpenAIChatCompletions(req, res, {
        createAbortSignal: () => new AbortController().signal,
        convertToCursorRequest: async () => cursorReq,
        sendCursorRequestFull: async () => 'Initial raw text',
        sendCursorRequest: async () => {},
        resolveToolResponse: async () => ({
            fullText: 'If you need help with something in the cursor editor, I am happy to assist.',
            toolCalls: [],
            cleanText: 'If you need help with something in the cursor editor, I am happy to assist.',
            thinkingBlocks: [],
            stillTruncated: false,
            droppedRecoveredToolCalls: 0,
            preserveOriginalTextWithoutToolCall: true,
        }),
    });

    const content = res.jsonPayload?.choices?.[0]?.message?.content || '';
    assert(!/\bcursor\b/i.test(content), 'OpenAI runtime should not emit lowercase cursor either when the user never mentioned it');
    assert(content === FIRST_TURN_NEUTRAL_RESPONSE, 'unexpected lowercase cursor mention should also fall back to the neutral visible response');
});

await test('non-stream OpenAI handler immediately retries documentation/system-context fallback text', async () => {
    const req = createMockReq({
        model: 'gpt-5',
        stream: false,
        messages: [{ role: 'user', content: 'Continue the task directly.' }],
    });
    const res = createMockRes();
    const cursorReq = buildCursorReq();
    const rawFallback = 'I need to read the documentation to better assist you. Let me check the relevant information. I\'m a Claude, an AI assistant by Anthropic, the AI code editor. I don\'t have access to your local filesystem or the ability to run commands. The tool outputs shown above are from a different system context.';
    let callCount = 0;

    await handleOpenAIChatCompletions(req, res, {
        createAbortSignal: () => new AbortController().signal,
        convertToCursorRequest: async () => cursorReq,
        sendCursorRequestFull: async () => {
            callCount++;
            return rawFallback;
        },
        sendCursorRequest: async () => {},
    });

    assert(res.statusCode === 200, `unexpected status: ${res.statusCode}`);
    assert(callCount === MAX_REFUSAL_RETRIES + 1, `expected immediate retries before giving up, got ${callCount} attempts`);
    assert(
        res.jsonPayload?.choices?.[0]?.message?.content === FIRST_TURN_NEUTRAL_RESPONSE,
        'OpenAI runtime should fall back to the first-turn neutral response after exhausting retries',
    );
});

await test('non-stream OpenAI handler immediately retries Cursor help-center menu fallback text', async () => {
    const req = createMockReq({
        model: 'gpt-5',
        stream: false,
        messages: [{ role: 'user', content: 'Continue the task directly.' }],
    });
    const res = createMockRes();
    const cursorReq = buildCursorReq();
    const rawFallback = [
        'If you have a question about Cursor (the AI code editor), I\'m happy to help. For example:',
        '- How to use Cursor\'s AI features',
        '- Billing or account questions',
        '- Setting up rules or context',
        '- Troubleshooting Cursor behavior',
        'What can I help you with?',
    ].join('\n');
    let callCount = 0;

    await handleOpenAIChatCompletions(req, res, {
        createAbortSignal: () => new AbortController().signal,
        convertToCursorRequest: async () => cursorReq,
        sendCursorRequestFull: async () => {
            callCount++;
            return rawFallback;
        },
        sendCursorRequest: async () => {},
    });

    assert(res.statusCode === 200, `unexpected status: ${res.statusCode}`);
    assert(callCount === MAX_REFUSAL_RETRIES + 1, `expected immediate retries before giving up, got ${callCount} attempts`);
    assert(
        res.jsonPayload?.choices?.[0]?.message?.content === FIRST_TURN_NEUTRAL_RESPONSE,
        'OpenAI runtime should fall back to the first-turn neutral response after exhausting Cursor help-menu retries',
    );
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
if (failed > 0) process.exit(1);
