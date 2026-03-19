import { RequestQueue, formatQueueRuntimeStatus } from '../src/queue.ts';

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

function assertEqual(actual, expected, message) {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);
    if (actualJson !== expectedJson) {
        throw new Error(message || `Expected ${expectedJson}, got ${actualJson}`);
    }
}

console.log('\n📦 queue runtime\n');

test('RequestQueue exposes the configured concurrency limit for runtime logging', () => {
    const queue = new RequestQueue({ concurrency: 7 });

    assertEqual(queue.concurrencyLimit, 7);
    assertEqual(queue.activeCount, 0);
    assertEqual(queue.pendingCount, 0);
});

test('formatQueueRuntimeStatus prints active, limit, and pending counts', () => {
    const status = formatQueueRuntimeStatus({
        activeCount: 2,
        concurrencyLimit: 8,
        pendingCount: 5,
    });

    assertEqual(status, '运行中=2/8, 队列等待=5');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
if (failed > 0) process.exit(1);
