import {
    buildUsageCostLog,
    estimateCursorUsageCost,
    extractCursorUsageFromEvent,
    normalizeCursorUsage,
    preferCursorUsage,
    toAnthropicUsage,
    toOpenAIUsage,
} from '../src/cursor-usage.ts';

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
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(message || `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

console.log('\n📦 cursor usage mapping\n');

test('normalizeCursorUsage prefers nested metadata shape and preserves details', () => {
    const usage = normalizeCursorUsage(
        { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        {
            inputTokens: 31981,
            outputTokens: 795,
            totalTokens: 32776,
            reasoningTokens: 549,
            cachedInputTokens: 12267,
            inputTokenDetails: { noCacheTokens: 19714, cacheReadTokens: 12267 },
            outputTokenDetails: { textTokens: 246, reasoningTokens: 549 },
        },
    );

    assert(usage?.isReal === true, 'normalized usage should be marked real');
    assertEqual(usage?.inputTokens, 31981);
    assertEqual(usage?.outputTokens, 795);
    assertEqual(usage?.cachedInputTokens, 12267);
    assertEqual(usage?.outputTokenDetails?.textTokens, 246);
});

test('extractCursorUsageFromEvent reads root metadata usage', () => {
    const usage = extractCursorUsageFromEvent({
        role: 'assistant',
        metadata: {
            usage: {
                inputTokens: 100,
                outputTokens: 20,
                totalTokens: 120,
                cachedInputTokens: 40,
            },
        },
    });

    assertEqual(usage?.inputTokens, 100);
    assertEqual(usage?.outputTokens, 20);
    assertEqual(usage?.cachedInputTokens, 40);
});

test('extractCursorUsageFromEvent reads assistant metadata usage', () => {
    const usage = extractCursorUsageFromEvent({
        type: 'message_stop',
        assistant: {
            metadata: {
                usage: {
                    inputTokens: 55,
                    outputTokens: 13,
                    totalTokens: 68,
                    reasoningTokens: 5,
                },
            },
        },
    });

    assertEqual(usage?.inputTokens, 55);
    assertEqual(usage?.outputTokens, 13);
    assertEqual(usage?.reasoningTokens, 5);
});

test('extractCursorUsageFromEvent merges root and assistant metadata usage', () => {
    const usage = extractCursorUsageFromEvent({
        type: 'message_stop',
        metadata: {
            usage: {
                inputTokens: 70,
                outputTokens: 10,
                totalTokens: 80,
                cachedInputTokens: 20,
            },
        },
        assistant: {
            metadata: {
                usage: {
                    reasoningTokens: 4,
                    outputTokenDetails: { textTokens: 6, reasoningTokens: 4 },
                },
            },
        },
    });

    assertEqual(usage?.inputTokens, 70);
    assertEqual(usage?.cachedInputTokens, 20);
    assertEqual(usage?.reasoningTokens, 4);
    assertEqual(usage?.outputTokenDetails?.textTokens, 6);
});

test('extractCursorUsageFromEvent falls back to top-level snake_case usage', () => {
    const usage = extractCursorUsageFromEvent({
        type: 'message_stop',
        usage: {
            prompt_tokens: 12,
            completion_tokens: 8,
            total_tokens: 20,
        },
    });

    assertEqual(usage?.inputTokens, 12);
    assertEqual(usage?.outputTokens, 8);
    assertEqual(usage?.totalTokens, 20);
});

test('toAnthropicUsage maps cache read tokens and fallback correctly', () => {
    const usage = toAnthropicUsage({
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        cachedInputTokens: 3,
        isReal: true,
    });

    assertEqual(usage, {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 3,
    });
});

test('preferCursorUsage keeps the more complete usage object', () => {
    const detailed = {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        reasoningTokens: 12,
        cachedInputTokens: 40,
        outputTokenDetails: { textTokens: 8, reasoningTokens: 12 },
        isReal: true,
    };
    const plain = {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        isReal: true,
    };

    assertEqual(preferCursorUsage(detailed, plain), detailed);
    assertEqual(preferCursorUsage(plain, detailed), detailed);
});

test('toOpenAIUsage maps detail fields into OpenAI-compatible structure', () => {
    const usage = toOpenAIUsage({
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        reasoningTokens: 2,
        cachedInputTokens: 3,
        inputTokenDetails: { noCacheTokens: 7, cacheReadTokens: 3 },
        outputTokenDetails: { textTokens: 2, reasoningTokens: 2 },
        isReal: true,
    });

    assertEqual(usage, {
        prompt_tokens: 10,
        completion_tokens: 4,
        total_tokens: 14,
        prompt_tokens_details: {
            cached_tokens: 3,
            uncached_tokens: 7,
        },
        completion_tokens_details: {
            reasoning_tokens: 2,
            text_tokens: 2,
        },
    });
});

test('estimateCursorUsageCost uses Cursor pricing table for known models', () => {
    const cost = estimateCursorUsageCost('anthropic/claude-sonnet-4.6', {
        inputTokens: 31981,
        outputTokens: 795,
        totalTokens: 32776,
        cachedInputTokens: 12267,
        inputTokenDetails: { noCacheTokens: 19714, cacheReadTokens: 12267 },
        isReal: true,
    });

    assertEqual(cost?.pricingModel, 'claude-4.6-sonnet');
    assertEqual(cost?.inputTokens, 19714);
    assertEqual(cost?.cacheReadTokens, 12267);
    assertEqual(cost?.outputTokens, 795);
    assert(cost && Math.abs(cost.totalUsd - 0.0747471) < 1e-9, 'should compute expected USD cost');
});

test('buildUsageCostLog includes estimated cost and source', () => {
    const line = buildUsageCostLog('OpenAI', {
        model: 'google/gemini-3-flash',
        source: 'cursor',
        stream: false,
        usage: {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
            cachedInputTokens: 40,
            inputTokenDetails: { noCacheTokens: 60, cacheReadTokens: 40 },
            reasoningTokens: 12,
            isReal: true,
        },
    });

    assert(line.includes('[OpenAI] 返回 usage/cost:'), 'should use prefixed log format');
    assert(line.includes('source=cursor'), 'should include source');
    assert(line.includes('estimated_cost_usd='), 'should include estimated cost');
    assert(line.includes('pricing_model=gemini-3-flash'), 'should include pricing model');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);

if (failed > 0) process.exit(1);
