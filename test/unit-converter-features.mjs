import { convertToCursorRequest } from '../src/converter.ts';
import { THINKING_HINT } from '../src/thinking.ts';
import { isRefusal } from '../src/handler.ts';

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

console.log('\n📦 converter selective merge features\n');

await test('convertToCursorRequest strips billing header lines and honors request-level thinking', async () => {
    const cursorReq = await convertToCursorRequest({
        model: 'claude-sonnet-4',
        max_tokens: 1024,
        thinking: { type: 'enabled' },
        system: 'alpha\nx-anthropic-billing-header: should-remove\nbeta',
        messages: [{ role: 'user', content: 'Use the available actions' }],
        tools: [{
            name: 'CustomTool',
            description: 'Do custom work',
            input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        }],
    });

    const prompt = cursorReq.messages[0]?.parts[0]?.text || '';
    assert(prompt.includes('alpha'), 'system prompt should keep original content');
    assert(prompt.includes('beta'), 'system prompt should keep trailing content');
    assert(!prompt.includes('x-anthropic-billing-header'), 'billing header line should be removed');
    assert(prompt.includes(THINKING_HINT), 'request-level thinking should inject thinking hint');
});

await test('convertToCursorRequest strips indented billing header lines', async () => {
    const cursorReq = await convertToCursorRequest({
        model: 'claude-sonnet-4',
        max_tokens: 1024,
        system: 'alpha\n   x-anthropic-billing-header: should-remove\nbeta',
        messages: [{ role: 'user', content: 'Continue the task' }],
        tools: [{
            name: 'CustomTool',
            description: 'Do custom work',
            input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        }],
    });

    const prompt = cursorReq.messages[0]?.parts[0]?.text || '';
    assert(!prompt.includes('x-anthropic-billing-header'), 'indented billing header line should be removed');
});

await test('buildToolInstructions keeps action-tool descriptions and skips communication-tool descriptions', async () => {
    const cursorReq = await convertToCursorRequest({
        model: 'claude-sonnet-4',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Inspect and write files' }],
        tools: [
            {
                name: 'Read',
                description: 'Read file contents from disk',
                input_schema: { type: 'object', properties: { path: { type: 'string' } } },
            },
            {
                name: 'attempt_completion',
                description: 'Signal task completion to the user.',
                input_schema: { type: 'object', properties: { result: { type: 'string' } } },
            },
            {
                name: 'CustomTool',
                description: 'Do custom work',
                input_schema: { type: 'object', properties: { target: { type: 'string' } } },
            },
        ],
    });

    const prompt = cursorReq.messages[0]?.parts[0]?.text || '';
    assert(prompt.includes('- **Read**: Read file contents from disk'), 'Read description should remain for filesystem semantics');
    assert(prompt.includes('- **attempt_completion**\n  Schema:'), 'communication tool should keep schema line');
    assert(!prompt.includes('- **attempt_completion**: Signal task completion to the user.'), 'communication tool description should be skipped');
    assert(prompt.includes('- **CustomTool**: Do custom work'), 'custom tool description should remain');
});

await test('communication tool description skipping is case-insensitive', async () => {
    const cursorReq = await convertToCursorRequest({
        model: 'claude-sonnet-4',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Inspect files' }],
        tools: [{
            name: 'AttemptCompletion',
            description: 'Signal task completion to the user.',
            input_schema: { type: 'object', properties: { result: { type: 'string' } } },
        }],
    });

    const prompt = cursorReq.messages[0]?.parts[0]?.text || '';
    assert(prompt.includes('- **AttemptCompletion**\n  Schema:'), 'case-insensitive communication tool should keep schema line');
    assert(!prompt.includes('- **AttemptCompletion**: Signal task completion to the user.'), 'case-insensitive communication tool description should be skipped');
});

await test('isRefusal recognizes the newly added Cursor refusal phrases', async () => {
    assert(isRefusal("This isn't something I can help with."), 'missing refusal phrase 1');
    assert(isRefusal('This is not something I can help with right now.'), 'missing refusal phrase 2');
    assert(isRefusal('I am scoped to answering questions about Cursor.'), 'missing refusal phrase 3');
    assert(isRefusal('That falls outside the scope of what I can do.'), 'missing refusal phrase 4');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计\n`);

if (failed > 0) process.exit(1);
