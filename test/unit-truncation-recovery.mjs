import { deduplicateContinuation, isTruncated } from '../src/handler.ts';
import { parseToolCalls } from '../src/converter.ts';

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
    assert(isTruncated(response), 'response should still be marked truncated when a later call is incomplete');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计\n`);

if (failed > 0) process.exit(1);
