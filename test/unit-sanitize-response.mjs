import { sanitizeResponse } from '../src/handler.ts';

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

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计\n`);

if (failed > 0) process.exit(1);
