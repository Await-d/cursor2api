import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { AirportSubscriptionConfig, AppConfig, ProxySubscriptionConfig } from './types.js';

let config: AppConfig;

export function getConfigPath(): string {
    const configuredPath = process.env.CONFIG_YAML_PATH?.trim();
    return configuredPath || 'config.yaml';
}

export function readFiniteInt(raw: unknown): number | undefined {
    if (raw === undefined || raw === null) return undefined;

    let value: number;
    if (typeof raw === 'number') {
        value = raw;
    } else if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return undefined;
        value = Number(trimmed);
    } else {
        return undefined;
    }

    if (!Number.isFinite(value)) return undefined;
    return Math.trunc(value);
}

function finiteIntOr(raw: unknown, fallback: number): number {
    const parsed = readFiniteInt(raw);
    return parsed === undefined ? fallback : parsed;
}

function intervalMsOrOff(raw: unknown, fallback: number, minimumWhenEnabled: number): number {
    const parsed = readFiniteInt(raw);
    if (parsed === undefined) return fallback;
    if (parsed <= 0) return 0;
    return Math.max(minimumWhenEnabled, parsed);
}

function normalizeCoreConfig(current: AppConfig): void {
    current.port = Math.max(1, finiteIntOr(current.port, 3010));
    current.timeout = Math.max(1, finiteIntOr(current.timeout, 120));
    current.concurrency = Math.max(1, finiteIntOr(current.concurrency, 3));
    current.queueStatusLogIntervalMs = intervalMsOrOff(current.queueStatusLogIntervalMs, 60_000, 5_000);
    current.queueTimeout = Math.max(1_000, finiteIntOr(current.queueTimeout, 120_000));
    current.retryDelay = Math.max(0, finiteIntOr(current.retryDelay, 5_000));
    current.maxRetryDelay = Math.max(current.retryDelay, finiteIntOr(current.maxRetryDelay, 60_000));
}

function normalizeRoutingConfig(current: AppConfig): void {
    current.direct429CooldownMs = Math.max(0, finiteIntOr(current.direct429CooldownMs, 10_000));
    current.proxyHealthCheckIntervalMs = Math.max(5_000, finiteIntOr(current.proxyHealthCheckIntervalMs, 30_000));
    current.proxyProbeTimeoutMs = Math.max(500, finiteIntOr(current.proxyProbeTimeoutMs, 5_000));
    current.proxyPauseBaseMs = Math.max(1_000, finiteIntOr(current.proxyPauseBaseMs, 15_000));
    current.proxyPauseMaxMs = Math.max(current.proxyPauseBaseMs, finiteIntOr(current.proxyPauseMaxMs, 300_000));
    current.proxySubscriptionRefreshMs = Math.max(60_000, finiteIntOr(current.proxySubscriptionRefreshMs, 30 * 60_000));
    current.proxySubscriptionTimeoutMs = Math.max(1_000, finiteIntOr(current.proxySubscriptionTimeoutMs, 15_000));
    current.proxySubscriptionMaxBytes = Math.max(16_384, finiteIntOr(current.proxySubscriptionMaxBytes, 2 * 1024 * 1024));
    current.proxySubscriptionApiEnabled = current.proxySubscriptionApiEnabled === true;
    current.proxySubscriptionApiToken = current.proxySubscriptionApiToken.trim();
    current.airportRuntimeBinaryPath = current.airportRuntimeBinaryPath.trim() || 'mihomo';
    current.airportRuntimeSocksPort = Math.max(1, finiteIntOr(current.airportRuntimeSocksPort, 17891));
    current.airportRuntimeControlPort = Math.max(1, finiteIntOr(current.airportRuntimeControlPort, 17892));
    current.airportRuntimeWorkDir = current.airportRuntimeWorkDir.trim() || '.cursor2api-airport';
    current.airportRuntimeTestUrl = current.airportRuntimeTestUrl.trim() || 'https://www.gstatic.com/generate_204';
    current.airportRuntimeTestIntervalSeconds = Math.max(60, finiteIntOr(current.airportRuntimeTestIntervalSeconds, 300));
    current.airportRuntimeLogLevel = ['silent', 'error', 'warning', 'info', 'debug'].includes(current.airportRuntimeLogLevel)
        ? current.airportRuntimeLogLevel
        : 'warning';
    current.airportRuntimeMode = ['auto', 'combined', 'per-subscription'].includes(current.airportRuntimeMode)
        ? current.airportRuntimeMode
        : 'combined';
    current.airportRuntimeGroupType = current.airportRuntimeGroupType === 'load-balance' ? 'load-balance' : 'url-test';
    current.airportRuntimeGroupStrategy = ['round-robin', 'consistent-hashing', 'sticky-sessions'].includes(current.airportRuntimeGroupStrategy)
        ? current.airportRuntimeGroupStrategy
        : '';
    current.proxySubscriptions = current.proxySubscriptions.map((subscription) => ({
        ...subscription,
        name: subscription.name.trim() || subscription.url.trim(),
        url: subscription.url.trim(),
        enabled: subscription.enabled !== false,
        refreshIntervalMs: Math.max(60_000, finiteIntOr(subscription.refreshIntervalMs, current.proxySubscriptionRefreshMs)),
        format: subscription.format,
    })).filter((subscription) => Boolean(subscription.url));
    current.airportSubscriptions = current.airportSubscriptions.map((subscription) => ({
        ...subscription,
        name: subscription.name.trim() || subscription.url.trim(),
        url: subscription.url.trim(),
        enabled: subscription.enabled !== false,
        intervalSeconds: Math.max(60, finiteIntOr(subscription.intervalSeconds, 3600)),
        filter: subscription.filter.trim(),
        excludeFilter: subscription.excludeFilter.trim(),
        excludeType: subscription.excludeType.trim(),
        headers: Object.fromEntries(
            Object.entries(subscription.headers).filter(([key, value]) => key.trim() && value.trim()),
        ),
    })).filter((subscription) => Boolean(subscription.url));
}

export function parseModelMapping(raw: unknown): Record<string, string> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }

    const mapping: Record<string, string> = {};
    for (const [from, to] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof to !== 'string') continue;
        const source = from.trim();
        const target = to.trim();
        if (!source || !target) continue;
        mapping[source] = target;
    }

    return mapping;
}

export function parseProxySubscriptions(raw: unknown, defaultRefreshMs: number): ProxySubscriptionConfig[] {
    if (!Array.isArray(raw)) {
        return [];
    }

    const subscriptions: ProxySubscriptionConfig[] = [];
    for (const entry of raw) {
        if (typeof entry === 'string') {
            const url = entry.trim();
            if (!url) continue;
            subscriptions.push({
                name: url,
                url,
                enabled: true,
                refreshIntervalMs: Math.max(60_000, defaultRefreshMs),
                format: 'auto',
            });
            continue;
        }

        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            continue;
        }

        const record = entry as Record<string, unknown>;
        const url = typeof record.url === 'string' ? record.url.trim() : '';
        if (!url) continue;

        const name = typeof record.name === 'string' ? record.name.trim() : url;
        const enabled = typeof record.enabled === 'boolean' ? record.enabled : true;
        const refreshIntervalMs = Math.max(
            60_000,
            finiteIntOr(record.refresh_interval_ms ?? record.refreshIntervalMs, defaultRefreshMs),
        );

        const formatRaw = typeof record.format === 'string' ? record.format.trim().toLowerCase() : 'auto';
        const format: ProxySubscriptionConfig['format'] =
            formatRaw === 'url-list' || formatRaw === 'clash' || formatRaw === 'json'
                ? formatRaw
                : 'auto';

        subscriptions.push({
            name,
            url,
            enabled,
            refreshIntervalMs,
            format,
        });
    }

    return subscriptions;
}

function parseHeaders(raw: unknown): Record<string, string> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return {};
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== 'string') continue;
        const headerName = key.trim();
        const headerValue = value.trim();
        if (!headerName || !headerValue) continue;
        headers[headerName] = headerValue;
    }

    return headers;
}

export function parseAirportSubscriptions(raw: unknown): AirportSubscriptionConfig[] {
    if (!Array.isArray(raw)) {
        return [];
    }

    const subscriptions: AirportSubscriptionConfig[] = [];
    for (const entry of raw) {
        if (typeof entry === 'string') {
            const url = entry.trim();
            if (!url) continue;
            subscriptions.push({
                name: url,
                url,
                enabled: true,
                intervalSeconds: 3600,
                filter: '',
                excludeFilter: '',
                excludeType: '',
                headers: {},
            });
            continue;
        }

        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            continue;
        }

        const record = entry as Record<string, unknown>;
        const url = typeof record.url === 'string' ? record.url.trim() : '';
        if (!url) continue;

        subscriptions.push({
            name: typeof record.name === 'string' ? record.name.trim() : url,
            url,
            enabled: typeof record.enabled === 'boolean' ? record.enabled : true,
            intervalSeconds: Math.max(60, finiteIntOr(record.interval_seconds ?? record.intervalSeconds, 3600)),
            filter: typeof record.filter === 'string' ? record.filter : '',
            excludeFilter: typeof record.exclude_filter === 'string'
                ? record.exclude_filter
                : typeof record.excludeFilter === 'string'
                    ? record.excludeFilter
                    : '',
            excludeType: typeof record.exclude_type === 'string'
                ? record.exclude_type
                : typeof record.excludeType === 'string'
                    ? record.excludeType
                    : '',
            headers: parseHeaders(record.headers),
        });
    }

    return subscriptions;
}

export function resolveCursorModel(requestedModel?: string): string {
    const { cursorModel, modelMapping } = getConfig();

    if (!requestedModel) {
        return modelMapping['*'] || cursorModel;
    }

    return modelMapping[requestedModel] || modelMapping['*'] || cursorModel;
}

export function createDefaultConfig(): AppConfig {
    return {
        port: 3010,
        timeout: 120,
        cursorModel: 'anthropic/claude-sonnet-4.6',
        concurrency: 3,
        queueStatusLogIntervalMs: 60_000,
        queueTimeout: 120_000,
        retryDelay: 5_000,
        maxRetryDelay: 60_000,
        direct429CooldownMs: 10_000,
        proxyHealthCheckIntervalMs: 30_000,
        proxyProbeTimeoutMs: 5_000,
        proxyPauseBaseMs: 15_000,
        proxyPauseMaxMs: 300_000,
        enableThinking: false,
        modelMapping: {},
        systemPromptInject: '',
        proxyPool: [],
        proxySubscriptionRefreshMs: 30 * 60_000,
        proxySubscriptionTimeoutMs: 15_000,
        proxySubscriptionMaxBytes: 2 * 1024 * 1024,
        proxySubscriptionApiEnabled: false,
        proxySubscriptionApiToken: '',
        proxySubscriptions: [],
        airportRuntimeBinaryPath: 'mihomo',
        airportRuntimeSocksPort: 17891,
        airportRuntimeControlPort: 17892,
        airportRuntimeWorkDir: '.cursor2api-airport',
        airportRuntimeTestUrl: 'https://www.gstatic.com/generate_204',
        airportRuntimeTestIntervalSeconds: 300,
        airportRuntimeLogLevel: 'warning',
        airportRuntimeMode: 'combined',
        airportRuntimeGroupType: 'url-test',
        airportRuntimeGroupStrategy: '',
        airportSubscriptions: [],
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        },
    };
}

export function isTruthyEnvValue(raw: string): boolean {
    return /^(1|true|yes|on)$/i.test(raw);
}

export function getConfig(): AppConfig {
    if (config) return config;

    const configPath = getConfigPath();

    // 默认配置
    config = createDefaultConfig();

    // 从 config.yaml 加载
    if (existsSync(configPath)) {
        try {
            const raw = readFileSync(configPath, 'utf-8');
            const yaml = parseYaml(raw);
            if (yaml.port) config.port = yaml.port;
            if (yaml.timeout) config.timeout = yaml.timeout;
            if (yaml.proxy) config.proxy = yaml.proxy;
            if (yaml.cursor_model) config.cursorModel = yaml.cursor_model;
            if (yaml.concurrency) config.concurrency = yaml.concurrency;
            const queueStatusLogIntervalMs = readFiniteInt(yaml.queue_status_log_interval_ms);
            if (queueStatusLogIntervalMs !== undefined) config.queueStatusLogIntervalMs = queueStatusLogIntervalMs;
            if (yaml.queue_timeout) config.queueTimeout = yaml.queue_timeout;
            if (yaml.retry_delay) config.retryDelay = yaml.retry_delay;
            if (yaml.max_retry_delay) config.maxRetryDelay = yaml.max_retry_delay;
            const direct429CooldownMs = readFiniteInt(yaml.direct_429_cooldown_ms);
            if (direct429CooldownMs !== undefined) config.direct429CooldownMs = direct429CooldownMs;
            const proxySubscriptionRefreshMs = readFiniteInt(yaml.proxy_subscription_refresh_ms);
            if (proxySubscriptionRefreshMs !== undefined) config.proxySubscriptionRefreshMs = proxySubscriptionRefreshMs;
            const proxySubscriptionTimeoutMs = readFiniteInt(yaml.proxy_subscription_timeout_ms);
            if (proxySubscriptionTimeoutMs !== undefined) config.proxySubscriptionTimeoutMs = proxySubscriptionTimeoutMs;
            const proxySubscriptionMaxBytes = readFiniteInt(yaml.proxy_subscription_max_bytes);
            if (proxySubscriptionMaxBytes !== undefined) config.proxySubscriptionMaxBytes = proxySubscriptionMaxBytes;
            if (typeof yaml.proxy_subscription_api_enabled === 'boolean') config.proxySubscriptionApiEnabled = yaml.proxy_subscription_api_enabled;
            if (typeof yaml.proxy_subscription_api_token === 'string') config.proxySubscriptionApiToken = yaml.proxy_subscription_api_token;
            if (typeof yaml.airport_runtime_binary_path === 'string') config.airportRuntimeBinaryPath = yaml.airport_runtime_binary_path;
            const airportRuntimeSocksPort = readFiniteInt(yaml.airport_runtime_socks_port);
            if (airportRuntimeSocksPort !== undefined) config.airportRuntimeSocksPort = airportRuntimeSocksPort;
            const airportRuntimeControlPort = readFiniteInt(yaml.airport_runtime_control_port);
            if (airportRuntimeControlPort !== undefined) config.airportRuntimeControlPort = airportRuntimeControlPort;
            if (typeof yaml.airport_runtime_work_dir === 'string') config.airportRuntimeWorkDir = yaml.airport_runtime_work_dir;
            if (typeof yaml.airport_runtime_test_url === 'string') config.airportRuntimeTestUrl = yaml.airport_runtime_test_url;
            const airportRuntimeTestIntervalSeconds = readFiniteInt(yaml.airport_runtime_test_interval_seconds);
            if (airportRuntimeTestIntervalSeconds !== undefined) config.airportRuntimeTestIntervalSeconds = airportRuntimeTestIntervalSeconds;
            if (typeof yaml.airport_runtime_log_level === 'string') config.airportRuntimeLogLevel = yaml.airport_runtime_log_level as AppConfig['airportRuntimeLogLevel'];
            if (typeof yaml.airport_runtime_mode === 'string') config.airportRuntimeMode = yaml.airport_runtime_mode as AppConfig['airportRuntimeMode'];
            if (typeof yaml.airport_runtime_group_type === 'string') config.airportRuntimeGroupType = yaml.airport_runtime_group_type as AppConfig['airportRuntimeGroupType'];
            if (typeof yaml.airport_runtime_group_strategy === 'string') config.airportRuntimeGroupStrategy = yaml.airport_runtime_group_strategy as AppConfig['airportRuntimeGroupStrategy'];
            const proxyHealthCheckIntervalMs = readFiniteInt(yaml.proxy_health_check_interval_ms);
            if (proxyHealthCheckIntervalMs !== undefined) config.proxyHealthCheckIntervalMs = proxyHealthCheckIntervalMs;
            const proxyProbeTimeoutMs = readFiniteInt(yaml.proxy_probe_timeout_ms);
            if (proxyProbeTimeoutMs !== undefined) config.proxyProbeTimeoutMs = proxyProbeTimeoutMs;
            const proxyPauseBaseMs = readFiniteInt(yaml.proxy_pause_base_ms);
            if (proxyPauseBaseMs !== undefined) config.proxyPauseBaseMs = proxyPauseBaseMs;
            const proxyPauseMaxMs = readFiniteInt(yaml.proxy_pause_max_ms);
            if (proxyPauseMaxMs !== undefined) config.proxyPauseMaxMs = proxyPauseMaxMs;
            if (typeof yaml.enable_thinking === 'boolean') config.enableThinking = yaml.enable_thinking;
            if (typeof yaml.system_prompt_inject === 'string') config.systemPromptInject = yaml.system_prompt_inject;
            const yamlModelMapping = parseModelMapping(yaml.model_mapping ?? yaml.model_map);
            if (Object.keys(yamlModelMapping).length > 0) {
                config.modelMapping = yamlModelMapping;
            }
            if (yaml.fingerprint) {
                if (yaml.fingerprint.user_agent) config.fingerprint.userAgent = yaml.fingerprint.user_agent;
            }
            if (yaml.vision) {
                config.vision = {
                    enabled: yaml.vision.enabled !== false,
                    mode: yaml.vision.mode || 'ocr',
                    baseUrl: yaml.vision.base_url || 'https://api.openai.com/v1/chat/completions',
                    apiKey: yaml.vision.api_key || '',
                    model: yaml.vision.model || 'gpt-4o-mini',
                };
            }
            if (Array.isArray(yaml.proxy_pool)) {
                config.proxyPool = yaml.proxy_pool.filter((p: unknown) => typeof p === 'string' && (p as string).trim());
            }
            const yamlProxySubscriptions = parseProxySubscriptions(yaml.proxy_subscriptions, config.proxySubscriptionRefreshMs);
            if (yamlProxySubscriptions.length > 0) {
                config.proxySubscriptions = yamlProxySubscriptions;
            }
            const yamlAirportSubscriptions = parseAirportSubscriptions(yaml.airport_subscriptions);
            if (yamlAirportSubscriptions.length > 0) {
                config.airportSubscriptions = yamlAirportSubscriptions;
            }
            if (config.proxy && config.proxyPool.length === 0) {
                config.proxyPool = [config.proxy];
            }
        } catch (e) {
            console.warn(`[Config] 读取 ${configPath} 失败:`, e);
        }
    }

    // 环境变量覆盖
    if (process.env.PORT) config.port = parseInt(process.env.PORT);
    if (process.env.TIMEOUT) config.timeout = parseInt(process.env.TIMEOUT);
    if (process.env.PROXY) config.proxy = process.env.PROXY;
    if (process.env.CURSOR_MODEL) config.cursorModel = process.env.CURSOR_MODEL;
    if (process.env.CONCURRENCY) config.concurrency = parseInt(process.env.CONCURRENCY);
    const envQueueStatusLogIntervalMs = readFiniteInt(process.env.QUEUE_STATUS_LOG_INTERVAL_MS);
    if (envQueueStatusLogIntervalMs !== undefined) config.queueStatusLogIntervalMs = envQueueStatusLogIntervalMs;
    if (process.env.QUEUE_TIMEOUT) config.queueTimeout = parseInt(process.env.QUEUE_TIMEOUT);
    if (process.env.RETRY_DELAY) config.retryDelay = parseInt(process.env.RETRY_DELAY);
    if (process.env.MAX_RETRY_DELAY) config.maxRetryDelay = parseInt(process.env.MAX_RETRY_DELAY);
    const envDirect429CooldownMs = readFiniteInt(process.env.DIRECT_429_COOLDOWN_MS);
    if (envDirect429CooldownMs !== undefined) config.direct429CooldownMs = envDirect429CooldownMs;
    const envProxySubscriptionRefreshMs = readFiniteInt(process.env.PROXY_SUBSCRIPTION_REFRESH_MS);
    if (envProxySubscriptionRefreshMs !== undefined) config.proxySubscriptionRefreshMs = envProxySubscriptionRefreshMs;
    const envProxySubscriptionTimeoutMs = readFiniteInt(process.env.PROXY_SUBSCRIPTION_TIMEOUT_MS);
    if (envProxySubscriptionTimeoutMs !== undefined) config.proxySubscriptionTimeoutMs = envProxySubscriptionTimeoutMs;
    const envProxySubscriptionMaxBytes = readFiniteInt(process.env.PROXY_SUBSCRIPTION_MAX_BYTES);
    if (envProxySubscriptionMaxBytes !== undefined) config.proxySubscriptionMaxBytes = envProxySubscriptionMaxBytes;
    if (process.env.PROXY_SUBSCRIPTION_API_ENABLED) config.proxySubscriptionApiEnabled = isTruthyEnvValue(process.env.PROXY_SUBSCRIPTION_API_ENABLED);
    if (process.env.PROXY_SUBSCRIPTION_API_TOKEN) config.proxySubscriptionApiToken = process.env.PROXY_SUBSCRIPTION_API_TOKEN;
    if (process.env.AIRPORT_RUNTIME_BINARY_PATH) config.airportRuntimeBinaryPath = process.env.AIRPORT_RUNTIME_BINARY_PATH;
    const envAirportRuntimeSocksPort = readFiniteInt(process.env.AIRPORT_RUNTIME_SOCKS_PORT);
    if (envAirportRuntimeSocksPort !== undefined) config.airportRuntimeSocksPort = envAirportRuntimeSocksPort;
    const envAirportRuntimeControlPort = readFiniteInt(process.env.AIRPORT_RUNTIME_CONTROL_PORT);
    if (envAirportRuntimeControlPort !== undefined) config.airportRuntimeControlPort = envAirportRuntimeControlPort;
    if (process.env.AIRPORT_RUNTIME_WORK_DIR) config.airportRuntimeWorkDir = process.env.AIRPORT_RUNTIME_WORK_DIR;
    if (process.env.AIRPORT_RUNTIME_TEST_URL) config.airportRuntimeTestUrl = process.env.AIRPORT_RUNTIME_TEST_URL;
    const envAirportRuntimeTestIntervalSeconds = readFiniteInt(process.env.AIRPORT_RUNTIME_TEST_INTERVAL_SECONDS);
    if (envAirportRuntimeTestIntervalSeconds !== undefined) config.airportRuntimeTestIntervalSeconds = envAirportRuntimeTestIntervalSeconds;
    if (process.env.AIRPORT_RUNTIME_LOG_LEVEL) config.airportRuntimeLogLevel = process.env.AIRPORT_RUNTIME_LOG_LEVEL as AppConfig['airportRuntimeLogLevel'];
    if (process.env.AIRPORT_RUNTIME_MODE) config.airportRuntimeMode = process.env.AIRPORT_RUNTIME_MODE as AppConfig['airportRuntimeMode'];
    if (process.env.AIRPORT_RUNTIME_GROUP_TYPE) config.airportRuntimeGroupType = process.env.AIRPORT_RUNTIME_GROUP_TYPE as AppConfig['airportRuntimeGroupType'];
    if (process.env.AIRPORT_RUNTIME_GROUP_STRATEGY) config.airportRuntimeGroupStrategy = process.env.AIRPORT_RUNTIME_GROUP_STRATEGY as AppConfig['airportRuntimeGroupStrategy'];
    const envProxyHealthCheckIntervalMs = readFiniteInt(process.env.PROXY_HEALTH_CHECK_INTERVAL_MS);
    if (envProxyHealthCheckIntervalMs !== undefined) config.proxyHealthCheckIntervalMs = envProxyHealthCheckIntervalMs;
    const envProxyProbeTimeoutMs = readFiniteInt(process.env.PROXY_PROBE_TIMEOUT_MS);
    if (envProxyProbeTimeoutMs !== undefined) config.proxyProbeTimeoutMs = envProxyProbeTimeoutMs;
    const envProxyPauseBaseMs = readFiniteInt(process.env.PROXY_PAUSE_BASE_MS);
    if (envProxyPauseBaseMs !== undefined) config.proxyPauseBaseMs = envProxyPauseBaseMs;
    const envProxyPauseMaxMs = readFiniteInt(process.env.PROXY_PAUSE_MAX_MS);
    if (envProxyPauseMaxMs !== undefined) config.proxyPauseMaxMs = envProxyPauseMaxMs;
    if (process.env.ENABLE_THINKING) config.enableThinking = isTruthyEnvValue(process.env.ENABLE_THINKING);
    if (process.env.SYSTEM_PROMPT_INJECT) config.systemPromptInject = process.env.SYSTEM_PROMPT_INJECT;
    if (process.env.MODEL_MAPPING) {
        try {
            const parsed = JSON.parse(process.env.MODEL_MAPPING);
            config.modelMapping = parseModelMapping(parsed);
        } catch (e) {
            console.warn('[Config] 解析 MODEL_MAPPING 环境变量失败:', e);
        }
    }

    if (process.env.PROXY_POOL) {
        try {
            const parsed = JSON.parse(process.env.PROXY_POOL);
            if (Array.isArray(parsed)) {
                config.proxyPool = parsed.filter((p: unknown) => typeof p === 'string' && (p as string).trim());
            }
        } catch {
            config.proxyPool = process.env.PROXY_POOL.split(',').map(s => s.trim()).filter(Boolean);
        }
    }
    if (process.env.PROXY_SUBSCRIPTIONS) {
        try {
            const parsed = JSON.parse(process.env.PROXY_SUBSCRIPTIONS);
            config.proxySubscriptions = parseProxySubscriptions(parsed, config.proxySubscriptionRefreshMs);
        } catch (e) {
            console.warn('[Config] 解析 PROXY_SUBSCRIPTIONS 环境变量失败:', e);
        }
    }
    if (process.env.AIRPORT_SUBSCRIPTIONS) {
        try {
            const parsed = JSON.parse(process.env.AIRPORT_SUBSCRIPTIONS);
            config.airportSubscriptions = parseAirportSubscriptions(parsed);
        } catch (e) {
            console.warn('[Config] 解析 AIRPORT_SUBSCRIPTIONS 环境变量失败:', e);
        }
    }
    if (config.proxy && config.proxyPool.length === 0) {
        config.proxyPool = [config.proxy];
    }

    // 从 base64 FP 环境变量解析指纹
    if (process.env.FP) {
        try {
            const fp = JSON.parse(Buffer.from(process.env.FP, 'base64').toString());
            if (fp.userAgent) config.fingerprint.userAgent = fp.userAgent;
        } catch (e) {
            console.warn('[Config] 解析 FP 环境变量失败:', e);
        }
    }

    normalizeCoreConfig(config);
    normalizeRoutingConfig(config);
    return config;
}
