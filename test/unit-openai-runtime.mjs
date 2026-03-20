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

function parseOpenAIChunks(chunks) {
    return chunks
        .flatMap(chunk => String(chunk).split('\n\n'))
        .map(part => part.trim())
        .filter(Boolean)
        .filter(part => part.startsWith('data: '))
        .map(part => part.slice(6))
        .filter(part => part !== '[DONE]')
        .map(part => JSON.parse(part));
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
        sendCursorRequestFullWithUsage: async () => ({ fullText: 'Initial raw text', usage: undefined }),
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
        sendCursorRequestFullWithUsage: async () => ({ fullText: 'Initial raw text', usage: undefined }),
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
        sendCursorRequestFullWithUsage: async () => ({ fullText: 'Initial raw text', usage: undefined }),
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
        sendCursorRequestFullWithUsage: async () => ({ fullText: 'Initial raw text', usage: undefined }),
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
        sendCursorRequestFull: async () => rawFallback,
        sendCursorRequestFullWithUsage: async () => {
            callCount++;
            return { fullText: rawFallback, usage: undefined };
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
        sendCursorRequestFull: async () => rawFallback,
        sendCursorRequestFullWithUsage: async () => {
            callCount++;
            return { fullText: rawFallback, usage: undefined };
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

await test('non-stream OpenAI handler prefers real Cursor usage metadata over estimators', async () => {
    const req = createMockReq({
        model: 'gpt-5',
        stream: false,
        messages: [{ role: 'user', content: 'Continue the task directly.' }],
    });
    const res = createMockRes();
    const cursorReq = buildCursorReq();
    const resolvedUsage = {
        inputTokens: 31981,
        outputTokens: 795,
        totalTokens: 32776,
        reasoningTokens: 549,
        cachedInputTokens: 12267,
        inputTokenDetails: { noCacheTokens: 19714, cacheReadTokens: 12267 },
        outputTokenDetails: { textTokens: 246, reasoningTokens: 549 },
        isReal: true,
    };
    const originalLog = console.log;
    const logs = [];
    console.log = (...args) => {
        logs.push(args.join(' '));
    };

    try {
        await handleOpenAIChatCompletions(req, res, {
            createAbortSignal: () => new AbortController().signal,
            convertToCursorRequest: async () => cursorReq,
            sendCursorRequestFull: async () => 'Visible answer',
            sendCursorRequestFullWithUsage: async () => ({ fullText: 'Visible answer', usage: resolvedUsage }),
            sendCursorRequest: async () => {},
        });
    } finally {
        console.log = originalLog;
    }

    assert(res.jsonPayload?.usage?.prompt_tokens === 31981, 'should use real prompt tokens');
    assert(res.jsonPayload?.usage?.completion_tokens === 795, 'should use real completion tokens');
    assert(res.jsonPayload?.usage?.total_tokens === 32776, 'should use real total tokens');
    assert(res.jsonPayload?.usage?.prompt_tokens_details?.cached_tokens === 12267, 'should expose cached prompt token details');
    assert(res.jsonPayload?.usage?.completion_tokens_details?.reasoning_tokens === 549, 'should expose reasoning token details');
    assert(res.jsonPayload?.cursor_usage?.isReal === true, 'should preserve resolved Cursor usage metadata');
    assert(logs.some(line => line.includes('返回 usage/cost:') && line.includes('source=cursor') && line.includes('estimated_cost_usd=')), 'should log returned real usage cost');
});

await test('stream OpenAI handler emits real Cursor usage chunk when metadata usage is present', async () => {
    const req = createMockReq({
        model: 'gpt-5',
        stream: true,
        messages: [{ role: 'user', content: 'Continue the task directly.' }],
    });
    const res = createMockRes();
    const cursorReq = buildCursorReq();

    await handleOpenAIChatCompletions(req, res, {
        createAbortSignal: () => new AbortController().signal,
        convertToCursorRequest: async () => cursorReq,
        sendCursorRequestFull: async () => 'Visible answer',
        sendCursorRequestFullWithUsage: async () => ({ fullText: 'Visible answer', usage: undefined }),
        sendCursorRequest: async (_req, onChunk) => {
            onChunk({ type: 'text-delta', delta: 'Visible answer' });
            onChunk({
                role: 'assistant',
                metadata: {
                    usage: {
                        inputTokens: 100,
                        outputTokens: 20,
                        totalTokens: 120,
                        reasoningTokens: 12,
                        cachedInputTokens: 40,
                        inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40 },
                        outputTokenDetails: { textTokens: 8, reasoningTokens: 12 },
                    },
                },
            });
            onChunk({
                type: 'message_stop',
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 20,
                    total_tokens: 120,
                },
            });
        },
    });

    const payloads = parseOpenAIChunks(res.chunks);
    const usageChunk = payloads.find(payload => payload.usage);
    assert(usageChunk, 'expected a final usage chunk');
    assert(usageChunk.usage.prompt_tokens === 100, 'stream chunk should use real prompt tokens');
    assert(usageChunk.usage.completion_tokens === 20, 'stream chunk should use real completion tokens');
    assert(usageChunk.usage.total_tokens === 120, 'stream chunk should use real total tokens');
    assert(usageChunk.usage.prompt_tokens_details?.cached_tokens === 40, 'stream chunk should include cached prompt token details');
    assert(usageChunk.usage.completion_tokens_details?.reasoning_tokens === 12, 'stream chunk should include reasoning token details');
    assert(usageChunk.cursor_usage?.isReal === true, 'stream chunk should preserve Cursor usage metadata');
});

await test('non-stream OpenAI handler falls back to estimated usage when real usage is absent', async () => {
    const req = createMockReq({
        model: 'gpt-5',
        stream: false,
        messages: [{ role: 'user', content: 'Continue the task directly.' }],
    });
    const res = createMockRes();
    const cursorReq = buildCursorReq();

    await handleOpenAIChatCompletions(req, res, {
        createAbortSignal: () => new AbortController().signal,
        convertToCursorRequest: async () => cursorReq,
        sendCursorRequestFull: async () => 'Visible answer',
        sendCursorRequestFullWithUsage: async () => ({ fullText: 'Visible answer', usage: undefined }),
        sendCursorRequest: async () => {},
    });

    assert(typeof res.jsonPayload?.usage?.prompt_tokens === 'number', 'fallback should still return prompt tokens');
    assert(typeof res.jsonPayload?.usage?.completion_tokens === 'number', 'fallback should still return completion tokens');
    assert(!res.jsonPayload?.cursor_usage, 'fallback path should not attach cursor_usage metadata');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
if (failed > 0) process.exit(1);
