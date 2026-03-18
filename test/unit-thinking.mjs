import { extractThinking, THINKING_HINT } from '../src/thinking.ts';
import { convertToAnthropicRequest, formatOpenAIMockText, responsesToChatCompletions, stripMarkdownJsonWrapper } from '../src/openai-handler.ts';

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

test('extractThinking preserves visible answer after unclosed thinking block', () => {
    const input = 'Before<thinking>plan step 1\nplan step 2\n\nVisible answer continues here';
    const extracted = extractThinking(input);

    assertEqual(extracted.thinkingBlocks.map(block => block.thinking), ['plan step 1\nplan step 2']);
    assert(extracted.cleanText.includes('Visible answer continues here'), 'visible answer should remain after unclosed thinking extraction');
});

test('extractThinking preserves trailing action block after unclosed thinking block', () => {
    const input = 'Intro<thinking>plan the next read\n```json action\n{"tool":"Read","parameters":{"filePath":"src/index.ts"}}\n```';
    const extracted = extractThinking(input);

    assertEqual(extracted.thinkingBlocks.map(block => block.thinking), ['plan the next read']);
    assert(extracted.cleanText.includes('```json action'), 'tool action should remain available after unclosed thinking extraction');
});

test('THINKING_HINT explicitly requires closed tags', () => {
    assert(THINKING_HINT.includes('Always close the </thinking> tag'), 'thinking hint should explicitly require closing tag');
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

test('convertToAnthropicRequest enables thinking from reasoning_effort', () => {
    const result = convertToAnthropicRequest({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'Think carefully' }],
        reasoning_effort: 'high',
    });

    assertEqual(result.thinking, { type: 'enabled' });
});

test('convertToAnthropicRequest enables thinking for thinking models', () => {
    const result = convertToAnthropicRequest({
        model: 'gpt-5-thinking',
        messages: [{ role: 'user', content: 'Need deep reasoning' }],
    });

    assertEqual(result.thinking, { type: 'enabled' });
});

test('convertToAnthropicRequest appends response_format guidance to last user message', () => {
    const result = convertToAnthropicRequest({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'Return a payload' }],
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'payload',
                schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
            },
        },
    });

    assert(typeof result.messages[0].content === 'string', 'last user message should remain string');
    assert(result.messages[0].content.includes('Respond in plain JSON format without markdown wrapping.'), 'missing plain JSON guidance');
    assert(result.messages[0].content.includes('"ok"'), 'missing schema payload in appended guidance');
});

test('convertToAnthropicRequest respects caller max_tokens values', () => {
    const result = convertToAnthropicRequest({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'Short response only' }],
        max_tokens: 256,
    });

    assertEqual(result.max_tokens, 256);
});

test('convertToAnthropicRequest maps required tool_choice to any', () => {
    const result = convertToAnthropicRequest({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'Use a tool' }],
        tools: [{
            type: 'function',
            function: {
                name: 'Read',
                description: 'Read file contents',
                parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
        }],
        tool_choice: 'required',
    });

    assertEqual(result.tool_choice, { type: 'any' });
    assertEqual(result.tools?.length, 1);
});

test('convertToAnthropicRequest maps function tool_choice to specific tool', () => {
    const result = convertToAnthropicRequest({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'Read the file' }],
        tools: [{
            type: 'function',
            function: {
                name: 'Read',
                description: 'Read file contents',
                parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
        }],
        tool_choice: { type: 'function', function: { name: 'Read' } },
    });

    assertEqual(result.tool_choice, { type: 'tool', name: 'Read' });
});

test('convertToAnthropicRequest disables tools when tool_choice is none', () => {
    const result = convertToAnthropicRequest({
        model: 'gpt-5',
        messages: [{ role: 'user', content: 'Do not use tools' }],
        tools: [{
            type: 'function',
            function: {
                name: 'Read',
                description: 'Read file contents',
                parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
        }],
        tool_choice: 'none',
    });

    assertEqual(result.tools, undefined);
    assertEqual(result.tool_choice, undefined);
});

test('responsesToChatCompletions preserves response_format and reasoning_effort', () => {
    const responseFormat = { type: 'json_object' };
    const result = responsesToChatCompletions({
        model: 'gpt-5',
        input: 'Hello',
        response_format: responseFormat,
        reasoning_effort: 'medium',
    });

    assertEqual(result.response_format, responseFormat);
    assertEqual(result.reasoning_effort, 'medium');
});

test('stripMarkdownJsonWrapper unwraps fenced json payloads', () => {
    const input = '```json\n{\n  "ok": true\n}\n```';
    assertEqual(stripMarkdownJsonWrapper(input), '{\n  "ok": true\n}');
});

test('formatOpenAIMockText wraps json response_format', () => {
    const body = {
        model: 'gpt-5',
        messages: [],
        response_format: { type: 'json_object' },
    };
    const output = formatOpenAIMockText(body, 'Identity response');
    assertEqual(output, '{"message":"Identity response"}');
});

test('formatOpenAIMockText keeps text response_format', () => {
    const body = {
        model: 'gpt-5',
        messages: [],
        response_format: { type: 'text' },
    };
    const output = formatOpenAIMockText(body, 'Identity response');
    assertEqual(output, 'Identity response');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计\n`);

if (failed > 0) process.exit(1);
