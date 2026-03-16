import {
    deduplicateContinuation,
    finalizeToolResponseForClient,
    getAnthropicToolStopReason,
    getOpenAIToolFinishReason,
    isTruncated,
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

test('hasToolCalls ignores plain json fences without action signature', () => {
    const response = '```json\n{"note":"example"}\n```';
    assertEqual(hasToolCalls(response), false);
});

test('isTruncated ignores long plain text without structural truncation', () => {
    const longPlainText = 'A'.repeat(2600);
    assert(!isTruncated(longPlainText), 'long plain text alone should not be marked truncated');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计\n`);

if (failed > 0) process.exit(1);
