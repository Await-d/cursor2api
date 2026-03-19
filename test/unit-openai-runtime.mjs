import { handleOpenAIChatCompletions } from '../src/openai-handler.ts';

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

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
if (failed > 0) process.exit(1);
