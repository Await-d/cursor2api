import { shouldShortCircuitOpenAIIdentityProbe } from '../src/openai-handler.ts';

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

console.log('\n📦 openai identity probe\n');

test('plain greeting does not short-circuit OpenAI identity mock', () => {
    const anthropicReq = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
    };

    assert(!shouldShortCircuitOpenAIIdentityProbe(anthropicReq), 'plain greeting should continue to the normal pipeline');
});

test('explicit identity question still short-circuits OpenAI identity mock', () => {
    const anthropicReq = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'who are you?' }],
    };

    assert(shouldShortCircuitOpenAIIdentityProbe(anthropicReq), 'explicit identity question should still use the identity shortcut');
});

test('tool-enabled requests never short-circuit OpenAI identity mock', () => {
    const anthropicReq = {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        tools: [{ name: 'Read', description: 'Read', input_schema: { type: 'object', properties: {} } }],
        messages: [{ role: 'user', content: 'who are you?' }],
    };

    assert(!shouldShortCircuitOpenAIIdentityProbe(anthropicReq), 'tool-enabled requests should stay on the normal pipeline');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
if (failed > 0) process.exit(1);
