import { extractThinking } from '../src/thinking.ts';
import { responsesToChatCompletions } from '../src/openai-handler.ts';

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

console.log('\n📦 thinking integration\n');

test('extractThinking strips closed and unclosed thinking blocks', () => {
    const input = 'Before<thinking>plan step 1</thinking>Middle<thinking>unfinished';
    const extracted = extractThinking(input);

    assertEqual(extracted.thinkingBlocks.map(block => block.thinking), ['plan step 1', 'unfinished']);
    assertEqual(extracted.cleanText, 'BeforeMiddle');
});

test('responsesToChatCompletions keeps reasoning content from responses blocks', () => {
    const result = responsesToChatCompletions({
        model: 'gpt-5',
        input: [{
            role: 'assistant',
            content: [
                { type: 'reasoning', text: 'internal summary' },
                { type: 'output_text', text: 'visible answer' },
            ],
        }],
    });

    assertEqual(result.messages[0].role, 'assistant');
    assertEqual(result.messages[0].content, 'visible answer');
    assertEqual(result.messages[0].reasoning_content, 'internal summary');
});

test('responsesToChatCompletions keeps reasoning field payloads', () => {
    const result = responsesToChatCompletions({
        model: 'gpt-5',
        input: [{
            role: 'assistant',
            content: [
                { type: 'reasoning_content', reasoning: 'hidden chain' },
                { type: 'output_text', text: 'final answer' },
            ],
        }],
    });

    assertEqual(result.messages[0].reasoning_content, 'hidden chain');
    assertEqual(result.messages[0].content, 'final answer');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计\n`);

if (failed > 0) process.exit(1);
