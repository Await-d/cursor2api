import { sanitizeResponse, sanitizeResponseForRequest, CLAUDE_IDENTITY_RESPONSE, FIRST_TURN_NEUTRAL_RESPONSE } from '../src/handler.ts';

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

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计\n`);

if (failed > 0) process.exit(1);
