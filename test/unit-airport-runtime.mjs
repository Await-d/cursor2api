import { parse as parseYaml } from 'yaml';
import { buildAirportRuntimeBindings, buildAutoAirportRuntimeBindings, buildMihomoConfigDocument, resolveAirportRuntimeBindings } from '../src/airport-runtime.ts';
import { getConfig } from '../src/config.ts';

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

async function testAsync(name, fn) {
    try {
        await fn();
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

console.log('\n📦 airport runtime\n');

test('buildMihomoConfigDocument generates provider and group config', () => {
    const config = getConfig();
    const previous = {
        airportRuntimeSocksPort: config.airportRuntimeSocksPort,
        airportRuntimeControlPort: config.airportRuntimeControlPort,
        airportRuntimeTestUrl: config.airportRuntimeTestUrl,
        airportRuntimeTestIntervalSeconds: config.airportRuntimeTestIntervalSeconds,
        airportRuntimeLogLevel: config.airportRuntimeLogLevel,
        airportRuntimeMode: config.airportRuntimeMode,
        airportRuntimeGroupType: config.airportRuntimeGroupType,
        airportRuntimeGroupStrategy: config.airportRuntimeGroupStrategy,
        proxySubscriptionMaxBytes: config.proxySubscriptionMaxBytes,
    };

    config.airportRuntimeSocksPort = 17891;
    config.airportRuntimeControlPort = 17892;
    config.airportRuntimeTestUrl = 'https://www.gstatic.com/generate_204';
    config.airportRuntimeTestIntervalSeconds = 300;
    config.airportRuntimeLogLevel = 'warning';
    config.airportRuntimeMode = 'combined';
    config.airportRuntimeGroupType = 'url-test';
    config.airportRuntimeGroupStrategy = '';
    config.proxySubscriptionMaxBytes = 2 * 1024 * 1024;

    try {
        const document = buildMihomoConfigDocument([
            {
                name: 'airport-main',
                url: 'https://example.com/subscription',
                enabled: true,
                intervalSeconds: 3600,
                filter: '(?i)hk|sg',
                excludeFilter: 'test',
                excludeType: 'http',
                headers: {
                    Authorization: 'Bearer demo-token',
                },
            },
        ]);

        const parsed = parseYaml(document);
        assertEqual(parsed['socks-port'], 17891);
        assertEqual(parsed['external-controller'], '127.0.0.1:17892');
        assertEqual(parsed.mode, 'rule');
        assertEqual(parsed['log-level'], 'warning');
        assertEqual(parsed.profile['store-selected'], true);

        const provider = parsed['proxy-providers'].airport_provider_1;
        assertEqual(provider.type, 'http');
        assertEqual(provider.url, 'https://example.com/subscription');
        assertEqual(provider.path, './providers/provider-1.yaml');
        assertEqual(provider.interval, 3600);
        assertEqual(provider['size-limit'], 2 * 1024 * 1024);
        assertEqual(provider.filter, '(?i)hk|sg');
        assertEqual(provider['exclude-filter'], 'test');
        assertEqual(provider['exclude-type'], 'http');
        assertEqual(provider.header.Authorization, ['Bearer demo-token']);

        const group = parsed['proxy-groups'][0];
        assertEqual(group.name, 'cursor2api-airport-combined');
        assertEqual(group.type, 'url-test');
        assertEqual(group.use, ['airport_provider_1']);
        assertEqual(group.url, 'https://www.gstatic.com/generate_204');
        assertEqual(parsed.rules, ['MATCH,cursor2api-airport-combined']);
        assertEqual(parsed['socks-port'], 17891);
        assertEqual(parsed['bind-address'], '127.0.0.1');
    } finally {
        config.airportRuntimeSocksPort = previous.airportRuntimeSocksPort;
        config.airportRuntimeControlPort = previous.airportRuntimeControlPort;
        config.airportRuntimeTestUrl = previous.airportRuntimeTestUrl;
        config.airportRuntimeTestIntervalSeconds = previous.airportRuntimeTestIntervalSeconds;
        config.airportRuntimeLogLevel = previous.airportRuntimeLogLevel;
        config.airportRuntimeMode = previous.airportRuntimeMode;
        config.airportRuntimeGroupType = previous.airportRuntimeGroupType;
        config.airportRuntimeGroupStrategy = previous.airportRuntimeGroupStrategy;
        config.proxySubscriptionMaxBytes = previous.proxySubscriptionMaxBytes;
    }
});

test('buildMihomoConfigDocument supports load-balance strategy', () => {
    const config = getConfig();
    const previous = {
        airportRuntimeMode: config.airportRuntimeMode,
        airportRuntimeGroupType: config.airportRuntimeGroupType,
        airportRuntimeGroupStrategy: config.airportRuntimeGroupStrategy,
    };

    config.airportRuntimeMode = 'combined';
    config.airportRuntimeGroupType = 'load-balance';
    config.airportRuntimeGroupStrategy = 'round-robin';

    try {
        const parsed = parseYaml(buildMihomoConfigDocument([
            {
                name: 'airport-main',
                url: 'https://example.com/subscription',
                enabled: true,
                intervalSeconds: 3600,
                filter: '',
                excludeFilter: '',
                excludeType: '',
                headers: {},
            },
        ]));

        assertEqual(parsed['proxy-groups'][0].type, 'load-balance');
        assertEqual(parsed['proxy-groups'][0].strategy, 'round-robin');
    } finally {
        config.airportRuntimeMode = previous.airportRuntimeMode;
        config.airportRuntimeGroupType = previous.airportRuntimeGroupType;
        config.airportRuntimeGroupStrategy = previous.airportRuntimeGroupStrategy;
    }
});

test('buildAirportRuntimeBindings exposes multiple local exits in per-subscription mode', () => {
    const config = getConfig();
    const previous = {
        airportRuntimeMode: config.airportRuntimeMode,
        airportRuntimeSocksPort: config.airportRuntimeSocksPort,
    };

    config.airportRuntimeMode = 'per-subscription';
    config.airportRuntimeSocksPort = 17891;

    try {
        const bindings = buildAirportRuntimeBindings([
            {
                name: 'hk',
                url: 'https://example.com/subscription',
                enabled: true,
                intervalSeconds: 3600,
                filter: '(?i)hk',
                excludeFilter: '',
                excludeType: '',
                headers: {},
            },
            {
                name: 'sg',
                url: 'https://example.com/subscription',
                enabled: true,
                intervalSeconds: 3600,
                filter: '(?i)sg',
                excludeFilter: '',
                excludeType: '',
                headers: {},
            },
        ]);

        assertEqual(bindings.map((binding) => binding.endpoint), [
            'socks5://127.0.0.1:17891',
            'socks5://127.0.0.1:17893',
        ]);
        assertEqual(bindings.map((binding) => binding.groupName), [
            'cursor2api-airport-hk-1',
            'cursor2api-airport-sg-2',
        ]);
    } finally {
        config.airportRuntimeMode = previous.airportRuntimeMode;
        config.airportRuntimeSocksPort = previous.airportRuntimeSocksPort;
    }
});

test('buildMihomoConfigDocument adds per-subscription listeners', () => {
    const config = getConfig();
    const previous = {
        airportRuntimeMode: config.airportRuntimeMode,
        airportRuntimeSocksPort: config.airportRuntimeSocksPort,
        airportRuntimeGroupType: config.airportRuntimeGroupType,
    };

    config.airportRuntimeMode = 'per-subscription';
    config.airportRuntimeSocksPort = 17891;
    config.airportRuntimeGroupType = 'url-test';

    try {
        const parsed = parseYaml(buildMihomoConfigDocument([
            {
                name: 'hk',
                url: 'https://example.com/subscription',
                enabled: true,
                intervalSeconds: 3600,
                filter: '(?i)hk',
                excludeFilter: '',
                excludeType: '',
                headers: {},
            },
            {
                name: 'sg',
                url: 'https://example.com/subscription',
                enabled: true,
                intervalSeconds: 3600,
                filter: '(?i)sg',
                excludeFilter: '',
                excludeType: '',
                headers: {},
            },
        ]));

        assertEqual(parsed.listeners.map((listener) => listener.port), [17891, 17893]);
        assertEqual(parsed.listeners.map((listener) => listener.proxy), [
            'cursor2api-airport-hk-1',
            'cursor2api-airport-sg-2',
        ]);
        assertEqual(parsed.rules, ['MATCH,DIRECT']);
        assertEqual(parsed['proxy-groups'].map((group) => group.name), [
            'cursor2api-airport-hk-1',
            'cursor2api-airport-sg-2',
        ]);
    } finally {
        config.airportRuntimeMode = previous.airportRuntimeMode;
        config.airportRuntimeSocksPort = previous.airportRuntimeSocksPort;
        config.airportRuntimeGroupType = previous.airportRuntimeGroupType;
    }
});

test('buildAirportRuntimeBindings keeps per-subscription group names unique for duplicate labels', () => {
    const config = getConfig();
    const previous = {
        airportRuntimeMode: config.airportRuntimeMode,
        airportRuntimeSocksPort: config.airportRuntimeSocksPort,
    };

    config.airportRuntimeMode = 'per-subscription';
    config.airportRuntimeSocksPort = 17891;

    try {
        const bindings = buildAirportRuntimeBindings([
            {
                name: 'airport-main',
                url: 'https://example.com/subscription',
                enabled: true,
                intervalSeconds: 3600,
                filter: '(?i)hk',
                excludeFilter: '',
                excludeType: '',
                headers: {},
            },
            {
                name: 'airport-main',
                url: 'https://example.com/subscription',
                enabled: true,
                intervalSeconds: 3600,
                filter: '(?i)sg',
                excludeFilter: '',
                excludeType: '',
                headers: {},
            },
        ]);

        assertEqual(bindings.map((binding) => binding.groupName), [
            'cursor2api-airport-airport-main-1',
            'cursor2api-airport-airport-main-2',
        ]);
    } finally {
        config.airportRuntimeMode = previous.airportRuntimeMode;
        config.airportRuntimeSocksPort = previous.airportRuntimeSocksPort;
    }
});

test('buildAutoAirportRuntimeBindings creates region listeners from one subscription', () => {
    const config = getConfig();
    const previous = {
        airportRuntimeMode: config.airportRuntimeMode,
        airportRuntimeSocksPort: config.airportRuntimeSocksPort,
    };

    config.airportRuntimeMode = 'auto';
    config.airportRuntimeSocksPort = 17891;

    try {
        const subscription = {
            name: 'airport-main',
            url: 'https://example.com/subscription',
            enabled: true,
            intervalSeconds: 3600,
            filter: '',
            excludeFilter: '',
            excludeType: '',
            headers: {},
        };

        const bindings = buildAutoAirportRuntimeBindings([subscription], [
            '🇭🇰 IPLC 香港 1',
            '🇺🇸 IPLC 美国 1',
            '🇹🇼 家宽 台湾 1',
            '剩余流量：123GB',
            'Emby 教学服',
            '土耳其 1',
        ]);

        assertEqual(bindings.map((binding) => binding.groupName), [
            'cursor2api-airport-hk-1',
            'cursor2api-airport-us-2',
            'cursor2api-airport-tw-3',
            'cursor2api-airport-other-4',
        ]);
        assertEqual(bindings.map((binding) => binding.port), [17891, 17893, 17895, 17897]);
        assertEqual(bindings[0].groupFilter, '(?i)香港|hk|hong ?kong|🇭🇰');
        assertEqual(bindings[3].groupExcludeFilter, '(?i)剩余流量|到期时间|emby|资源服|教学服|porn|国内|永久|香港|hk|hong ?kong|🇭🇰|美国|us|usa|united states|洛杉矶|西雅图|圣何塞|芝加哥|纽约|🇺🇸|台湾|tw|taiwan|台北|🇹🇼|日本|jp|japan|东京|大阪|🇯🇵|新加坡|sg|singapore|🇸🇬');
    } finally {
        config.airportRuntimeMode = previous.airportRuntimeMode;
        config.airportRuntimeSocksPort = previous.airportRuntimeSocksPort;
    }
});

test('buildMihomoConfigDocument supports auto listeners when bindings are pre-resolved', () => {
    const config = getConfig();
    const previous = {
        airportRuntimeMode: config.airportRuntimeMode,
        airportRuntimeSocksPort: config.airportRuntimeSocksPort,
        airportRuntimeGroupType: config.airportRuntimeGroupType,
    };

    config.airportRuntimeMode = 'auto';
    config.airportRuntimeSocksPort = 17891;
    config.airportRuntimeGroupType = 'url-test';

    try {
        const subscription = {
            name: 'airport-main',
            url: 'https://example.com/subscription',
            enabled: true,
            intervalSeconds: 3600,
            filter: '',
            excludeFilter: '',
            excludeType: '',
            headers: {},
        };
        const bindings = buildAutoAirportRuntimeBindings([subscription], ['🇭🇰 香港 1', '🇺🇸 美国 1']);
        const parsed = parseYaml(buildMihomoConfigDocument([subscription], bindings));

        assertEqual(parsed.listeners.map((listener) => listener.port), [17891, 17893]);
        assertEqual(parsed.listeners.map((listener) => listener.proxy), [
            'cursor2api-airport-hk-1',
            'cursor2api-airport-us-2',
        ]);
        assertEqual(parsed['proxy-groups'][0].filter, '(?i)香港|hk|hong ?kong|🇭🇰');
        assertEqual(parsed.rules, ['MATCH,DIRECT']);
    } finally {
        config.airportRuntimeMode = previous.airportRuntimeMode;
        config.airportRuntimeSocksPort = previous.airportRuntimeSocksPort;
        config.airportRuntimeGroupType = previous.airportRuntimeGroupType;
    }
});

await testAsync('resolveAirportRuntimeBindings keeps explicit split behavior in auto mode', async () => {
    const config = getConfig();
    const previous = {
        airportRuntimeMode: config.airportRuntimeMode,
        airportRuntimeSocksPort: config.airportRuntimeSocksPort,
    };

    config.airportRuntimeMode = 'auto';
    config.airportRuntimeSocksPort = 17891;

    try {
        const bindings = await resolveAirportRuntimeBindings([
            {
                name: 'airport-main',
                url: 'https://example.com/subscription',
                enabled: true,
                intervalSeconds: 3600,
                filter: '(?i)hk',
                excludeFilter: '',
                excludeType: '',
                headers: {},
            },
            {
                name: 'airport-main',
                url: 'https://example.com/subscription',
                enabled: true,
                intervalSeconds: 3600,
                filter: '(?i)sg',
                excludeFilter: '',
                excludeType: '',
                headers: {},
            },
        ]);

        assertEqual(bindings.map((binding) => binding.endpoint), [
            'socks5://127.0.0.1:17891',
            'socks5://127.0.0.1:17893',
        ]);
    } finally {
        config.airportRuntimeMode = previous.airportRuntimeMode;
        config.airportRuntimeSocksPort = previous.airportRuntimeSocksPort;
    }
});

await testAsync('resolveAirportRuntimeBindings falls back to combined on inspection failure', async () => {
    const config = getConfig();
    const previous = {
        airportRuntimeMode: config.airportRuntimeMode,
        airportRuntimeSocksPort: config.airportRuntimeSocksPort,
    };
    const originalFetch = globalThis.fetch;

    config.airportRuntimeMode = 'auto';
    config.airportRuntimeSocksPort = 17891;
    globalThis.fetch = async () => {
        throw new Error('network down');
    };

    try {
        const bindings = await resolveAirportRuntimeBindings([
            {
                name: 'airport-main',
                url: 'https://example.com/subscription',
                enabled: true,
                intervalSeconds: 3600,
                filter: '',
                excludeFilter: '',
                excludeType: '',
                headers: {},
            },
        ]);

        assertEqual(bindings.map((binding) => binding.groupName), ['cursor2api-airport-combined']);
        assertEqual(bindings.map((binding) => binding.endpoint), ['socks5://127.0.0.1:17891']);
    } finally {
        globalThis.fetch = originalFetch;
        config.airportRuntimeMode = previous.airportRuntimeMode;
        config.airportRuntimeSocksPort = previous.airportRuntimeSocksPort;
    }
});

test('buildMihomoConfigDocument rejects non-http subscription urls', () => {
    let rejected = false;
    try {
        buildMihomoConfigDocument([
            {
                name: 'bad',
                url: 'vmess://demo',
                enabled: true,
                intervalSeconds: 3600,
                filter: '',
                excludeFilter: '',
                excludeType: '',
                headers: {},
            },
        ]);
    } catch (error) {
        rejected = error instanceof Error && error.message.includes('Airport subscription URLs must use http/https');
    }

    assert(rejected, 'non-http airport subscription urls should be rejected');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计\n`);

if (failed > 0) process.exit(1);
