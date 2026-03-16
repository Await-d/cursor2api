import {
    extractProxyUrlsFromSubscriptionPayload,
    mergeProxyPools,
    validateSubscriptionUrl,
} from '../src/proxy-subscriptions.ts';

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

console.log('\n📦 proxy subscriptions\n');

test('parses plain proxy URL lists', () => {
    const payload = [
        'https://user:pass@proxy-a.example.com:8443',
        'socks5://proxy-b.example.com:1080',
        'vmess://ignored-node',
    ].join('\n');

    const result = extractProxyUrlsFromSubscriptionPayload(payload);
    assertEqual(result, [
        'https://user:pass@proxy-a.example.com:8443',
        'socks5://proxy-b.example.com:1080',
    ]);
});

test('parses base64-encoded proxy URL lists', () => {
    const raw = [
        'http://proxy-c.example.com:8080',
        'socks5h://proxy-d.example.com:1081',
    ].join('\n');
    const payload = Buffer.from(raw, 'utf-8').toString('base64');

    const result = extractProxyUrlsFromSubscriptionPayload(payload);
    assertEqual(result, [
        'http://proxy-c.example.com:8080',
        'socks5h://proxy-d.example.com:1081',
    ]);
});

test('parses unpadded base64-encoded proxy URL lists', () => {
    const raw = 'https://proxy-e.example.com:8443';
    const payload = Buffer.from(raw, 'utf-8').toString('base64').replace(/=+$/g, '');

    const result = extractProxyUrlsFromSubscriptionPayload(payload);
    assertEqual(result, ['https://proxy-e.example.com:8443']);
});

test('parses clash-style YAML and ignores unsupported node types', () => {
    const payload = `proxies:
  - name: http-upstream
    type: http
    server: http.proxy.example.com
    port: 8080
    username: demo
    password: secret
  - name: socks-upstream
    type: socks5
    server: socks.proxy.example.com
    port: 1080
  - name: vmess-upstream
    type: vmess
    server: unsupported.example.com
    port: 443
`;

    const result = extractProxyUrlsFromSubscriptionPayload(payload, 'clash');
    assertEqual(result, [
        'http://demo:secret@http.proxy.example.com:8080',
        'socks5://socks.proxy.example.com:1080',
    ]);
});

test('parses json outbounds with supported proxy types only', () => {
    const payload = JSON.stringify({
        outbounds: [
            { type: 'socks', server: 'json-socks.example.com', port: 1080 },
            { type: 'http', server: 'json-http.example.com', port: 8080 },
            { type: 'trojan', server: 'unsupported.example.com', port: 443 },
        ],
    });

    const result = extractProxyUrlsFromSubscriptionPayload(payload, 'json');
    assertEqual(result, [
        'socks5://json-socks.example.com:1080',
        'http://json-http.example.com:8080',
    ]);
});

test('mergeProxyPools deduplicates static and imported proxies', () => {
    const result = mergeProxyPools(
        ['http://proxy-a.example.com:8080', 'socks5://proxy-b.example.com:1080'],
        ['socks5://proxy-b.example.com:1080', 'https://proxy-c.example.com:8443'],
    );

    assertEqual(result, [
        'http://proxy-a.example.com:8080',
        'socks5://proxy-b.example.com:1080',
        'https://proxy-c.example.com:8443',
    ]);
});

test('invalid or unsupported payloads produce empty imports', () => {
    assertEqual(extractProxyUrlsFromSubscriptionPayload('not-a-proxy-list'), []);
    assertEqual(extractProxyUrlsFromSubscriptionPayload('vmess://only-unsupported-node'), []);
    assert(!extractProxyUrlsFromSubscriptionPayload('vmess://only-unsupported-node').length, 'unsupported protocols should stay excluded');
});

test('subscription source URLs allow only http/https', () => {
    assertEqual(validateSubscriptionUrl('https://example.com/sub.txt'), 'https://example.com/sub.txt');
    assertEqual(validateSubscriptionUrl('http://example.com/sub.txt'), 'http://example.com/sub.txt');

    let rejected = false;
    try {
        validateSubscriptionUrl('ftp://example.com/sub.txt');
    } catch (error) {
        rejected = error instanceof Error && error.message.includes('Only http/https subscription URLs are supported');
    }

    assert(rejected, 'unsupported subscription URL schemes should be rejected');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计\n`);

if (failed > 0) process.exit(1);
