import { readFile, writeFile } from 'fs/promises';
import { parse as parseDotenv } from 'dotenv';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Request, Response } from 'express';
import {
    createDefaultConfig,
    getConfig,
    getConfigPath,
    isTruthyEnvValue,
    parseAirportSubscriptions,
    parseModelMapping,
    parseProxySubscriptions,
    readFiniteInt,
} from './config.js';
import type { AppConfig } from './types.js';

type ConfigShape = Record<string, unknown>;
type EnvFileValues = Record<string, string>;

function getAdminConfigPath(): string {
    return getConfigPath();
}

function getAdminEnvFilePath(): string | null {
    const configuredPath = process.env.ADMIN_ENV_FILE_PATH?.trim();
    return configuredPath || null;
}

function runtimeToShape(cfg: AppConfig): ConfigShape {
    return {
        port: cfg.port,
        timeout: cfg.timeout,
        proxy: cfg.proxy ?? '',
        cursor_model: cfg.cursorModel,
        concurrency: cfg.concurrency,
        queue_status_log_interval_ms: cfg.queueStatusLogIntervalMs,
        queue_timeout: cfg.queueTimeout,
        retry_delay: cfg.retryDelay,
        max_retry_delay: cfg.maxRetryDelay,
        direct_429_cooldown_ms: cfg.direct429CooldownMs,
        proxy_health_check_interval_ms: cfg.proxyHealthCheckIntervalMs,
        proxy_probe_timeout_ms: cfg.proxyProbeTimeoutMs,
        proxy_pause_base_ms: cfg.proxyPauseBaseMs,
        proxy_pause_max_ms: cfg.proxyPauseMaxMs,
        enable_thinking: cfg.enableThinking,
        system_prompt_inject: cfg.systemPromptInject,
        proxy_pool: cfg.proxyPool,
        proxy_subscription_refresh_ms: cfg.proxySubscriptionRefreshMs,
        proxy_subscription_timeout_ms: cfg.proxySubscriptionTimeoutMs,
        proxy_subscription_max_bytes: cfg.proxySubscriptionMaxBytes,
        proxy_subscription_api_enabled: cfg.proxySubscriptionApiEnabled,
        proxy_subscription_api_token: cfg.proxySubscriptionApiToken,
        airport_runtime_binary_path: cfg.airportRuntimeBinaryPath,
        airport_runtime_socks_port: cfg.airportRuntimeSocksPort,
        airport_runtime_control_port: cfg.airportRuntimeControlPort,
        airport_runtime_work_dir: cfg.airportRuntimeWorkDir,
        airport_runtime_test_url: cfg.airportRuntimeTestUrl,
        airport_runtime_test_interval_seconds: cfg.airportRuntimeTestIntervalSeconds,
        airport_runtime_log_level: cfg.airportRuntimeLogLevel,
        airport_runtime_mode: cfg.airportRuntimeMode,
        airport_runtime_group_type: cfg.airportRuntimeGroupType,
        airport_runtime_group_strategy: cfg.airportRuntimeGroupStrategy,
        proxy_subscriptions: cfg.proxySubscriptions.map(s => ({
            name: s.name,
            url: s.url,
            enabled: s.enabled,
            refresh_interval_ms: s.refreshIntervalMs,
            format: s.format,
        })),
        airport_subscriptions: cfg.airportSubscriptions.map(s => ({
            name: s.name,
            url: s.url,
            enabled: s.enabled,
            interval_seconds: s.intervalSeconds,
            filter: s.filter,
            exclude_filter: s.excludeFilter,
            exclude_type: s.excludeType,
            headers: s.headers,
        })),
        model_mapping: cfg.modelMapping,
        fingerprint: { user_agent: cfg.fingerprint.userAgent },
        vision: {
            enabled: cfg.vision?.enabled ?? false,
            mode: cfg.vision?.mode ?? 'ocr',
            base_url: cfg.vision?.baseUrl ?? '',
            api_key: cfg.vision?.apiKey ?? '',
            model: cfg.vision?.model ?? '',
        },
    };
}

const ALLOWED_SCALAR_KEYS = new Set([
    'port', 'timeout', 'cursor_model', 'concurrency', 'queue_status_log_interval_ms', 'queue_timeout',
    'retry_delay', 'max_retry_delay', 'enable_thinking', 'system_prompt_inject',
    'proxy', 'direct_429_cooldown_ms', 'proxy_health_check_interval_ms',
    'proxy_probe_timeout_ms', 'proxy_pause_base_ms', 'proxy_pause_max_ms',
    'proxy_subscription_refresh_ms', 'proxy_subscription_timeout_ms',
    'proxy_subscription_max_bytes', 'proxy_subscription_api_enabled',
    'proxy_subscription_api_token',
    'airport_runtime_binary_path', 'airport_runtime_socks_port',
    'airport_runtime_control_port', 'airport_runtime_work_dir',
    'airport_runtime_test_url', 'airport_runtime_test_interval_seconds',
    'airport_runtime_log_level', 'airport_runtime_mode',
    'airport_runtime_group_type', 'airport_runtime_group_strategy',
]);

const ALLOWED_OBJECT_KEYS = new Set(['vision', 'fingerprint', 'model_mapping']);
const ALLOWED_ARRAY_KEYS = new Set(['proxy_pool', 'proxy_subscriptions', 'airport_subscriptions']);

function toRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }

    return value as Record<string, unknown>;
}

function applyPersistedConfig(shape: ConfigShape, persisted: Record<string, unknown>): void {
    for (const key of ALLOWED_SCALAR_KEYS) {
        if (Object.prototype.hasOwnProperty.call(persisted, key)) {
            shape[key] = persisted[key];
        }
    }

    for (const key of ALLOWED_OBJECT_KEYS) {
        const value = persisted[key];
        if (toRecord(value)) {
            shape[key] = value;
        }
    }

    for (const key of ALLOWED_ARRAY_KEYS) {
        const value = persisted[key];
        if (Array.isArray(value)) {
            shape[key] = value;
        }
    }
}

function getErrorCode(err: unknown): string | undefined {
    if (!err || typeof err !== 'object' || !('code' in err)) {
        return undefined;
    }

    const { code } = err as NodeJS.ErrnoException;
    return typeof code === 'string' ? code : undefined;
}

function getNumber(shape: ConfigShape, key: string): number | undefined {
    return readFiniteInt(shape[key]);
}

function getString(shape: ConfigShape, key: string): string {
    const value = shape[key];
    return typeof value === 'string' ? value : '';
}

function getBoolean(shape: ConfigShape, key: string): boolean {
    return shape[key] === true;
}

function getObjectValue(shape: ConfigShape, key: string): Record<string, unknown> {
    return toRecord(shape[key]) ?? {};
}

function getStringArray(shape: ConfigShape, key: string): string[] {
    const value = shape[key];
    if (!Array.isArray(value)) {
        return [];
    }

    return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function getProxySubscriptionRefreshMs(shape: ConfigShape): number {
    return getNumber(shape, 'proxy_subscription_refresh_ms') ?? createDefaultConfig().proxySubscriptionRefreshMs;
}

function getNormalizedProxySubscriptions(shape: ConfigShape): Array<Record<string, unknown>> {
    return parseProxySubscriptions(shape.proxy_subscriptions, getProxySubscriptionRefreshMs(shape)).map(subscription => ({
        name: subscription.name,
        url: subscription.url,
        enabled: subscription.enabled,
        refresh_interval_ms: subscription.refreshIntervalMs,
        format: subscription.format,
    }));
}

function getNormalizedAirportSubscriptions(shape: ConfigShape): Array<Record<string, unknown>> {
    return parseAirportSubscriptions(shape.airport_subscriptions).map(subscription => ({
        name: subscription.name,
        url: subscription.url,
        enabled: subscription.enabled,
        interval_seconds: subscription.intervalSeconds,
        filter: subscription.filter,
        exclude_filter: subscription.excludeFilter,
        exclude_type: subscription.excludeType,
        headers: subscription.headers,
    }));
}

function getFingerprintUserAgent(shape: ConfigShape): string {
    const fingerprint = getObjectValue(shape, 'fingerprint');
    return typeof fingerprint.user_agent === 'string' ? fingerprint.user_agent : '';
}

interface EnvBinding {
    envName: string;
    apply: (shape: ConfigShape, raw: string) => void;
    serialize: (shape: ConfigShape) => string;
}

function stringBinding(shapeKey: string, envName: string): EnvBinding {
    return {
        envName,
        apply: (shape, raw) => {
            if (raw !== '') {
                shape[shapeKey] = raw;
            }
        },
        serialize: (shape) => {
            const value = getString(shape, shapeKey);
            if (shapeKey === 'system_prompt_inject' && /[\r\n]/.test(value)) {
                return '';
            }
            return value;
        },
    };
}

function numberBinding(shapeKey: string, envName: string): EnvBinding {
    return {
        envName,
        apply: (shape, raw) => {
            const parsed = readFiniteInt(raw);
            if (parsed !== undefined) {
                shape[shapeKey] = parsed;
            }
        },
        serialize: (shape) => {
            const value = getNumber(shape, shapeKey);
            return value === undefined ? '' : String(value);
        },
    };
}

function booleanBinding(shapeKey: string, envName: string): EnvBinding {
    return {
        envName,
        apply: (shape, raw) => {
            if (raw !== '') {
                shape[shapeKey] = isTruthyEnvValue(raw);
            }
        },
        serialize: (shape) => (getBoolean(shape, shapeKey) ? 'true' : 'false'),
    };
}

const ENV_BINDINGS: EnvBinding[] = [
    numberBinding('port', 'PORT'),
    numberBinding('timeout', 'TIMEOUT'),
    stringBinding('proxy', 'PROXY'),
    stringBinding('cursor_model', 'CURSOR_MODEL'),
    numberBinding('concurrency', 'CONCURRENCY'),
    numberBinding('queue_status_log_interval_ms', 'QUEUE_STATUS_LOG_INTERVAL_MS'),
    numberBinding('queue_timeout', 'QUEUE_TIMEOUT'),
    numberBinding('retry_delay', 'RETRY_DELAY'),
    numberBinding('max_retry_delay', 'MAX_RETRY_DELAY'),
    numberBinding('direct_429_cooldown_ms', 'DIRECT_429_COOLDOWN_MS'),
    numberBinding('proxy_health_check_interval_ms', 'PROXY_HEALTH_CHECK_INTERVAL_MS'),
    numberBinding('proxy_probe_timeout_ms', 'PROXY_PROBE_TIMEOUT_MS'),
    numberBinding('proxy_pause_base_ms', 'PROXY_PAUSE_BASE_MS'),
    numberBinding('proxy_pause_max_ms', 'PROXY_PAUSE_MAX_MS'),
    booleanBinding('enable_thinking', 'ENABLE_THINKING'),
    stringBinding('system_prompt_inject', 'SYSTEM_PROMPT_INJECT'),
    numberBinding('proxy_subscription_refresh_ms', 'PROXY_SUBSCRIPTION_REFRESH_MS'),
    numberBinding('proxy_subscription_timeout_ms', 'PROXY_SUBSCRIPTION_TIMEOUT_MS'),
    numberBinding('proxy_subscription_max_bytes', 'PROXY_SUBSCRIPTION_MAX_BYTES'),
    booleanBinding('proxy_subscription_api_enabled', 'PROXY_SUBSCRIPTION_API_ENABLED'),
    stringBinding('proxy_subscription_api_token', 'PROXY_SUBSCRIPTION_API_TOKEN'),
    stringBinding('airport_runtime_binary_path', 'AIRPORT_RUNTIME_BINARY_PATH'),
    numberBinding('airport_runtime_socks_port', 'AIRPORT_RUNTIME_SOCKS_PORT'),
    numberBinding('airport_runtime_control_port', 'AIRPORT_RUNTIME_CONTROL_PORT'),
    stringBinding('airport_runtime_work_dir', 'AIRPORT_RUNTIME_WORK_DIR'),
    stringBinding('airport_runtime_test_url', 'AIRPORT_RUNTIME_TEST_URL'),
    numberBinding('airport_runtime_test_interval_seconds', 'AIRPORT_RUNTIME_TEST_INTERVAL_SECONDS'),
    stringBinding('airport_runtime_log_level', 'AIRPORT_RUNTIME_LOG_LEVEL'),
    stringBinding('airport_runtime_mode', 'AIRPORT_RUNTIME_MODE'),
    stringBinding('airport_runtime_group_type', 'AIRPORT_RUNTIME_GROUP_TYPE'),
    stringBinding('airport_runtime_group_strategy', 'AIRPORT_RUNTIME_GROUP_STRATEGY'),
    {
        envName: 'MODEL_MAPPING',
        apply: (shape, raw) => {
            if (!raw) {
                return;
            }
            try {
                shape.model_mapping = parseModelMapping(JSON.parse(raw));
            } catch {
                shape.model_mapping = parseModelMapping(raw);
            }
        },
        serialize: (shape) => {
            const mapping = parseModelMapping(getObjectValue(shape, 'model_mapping'));
            return Object.keys(mapping).length === 0 ? '' : JSON.stringify(mapping);
        },
    },
    {
        envName: 'PROXY_POOL',
        apply: (shape, raw) => {
            if (!raw) {
                return;
            }
            try {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) {
                    shape.proxy_pool = parsed.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
                    return;
                }
            } catch {
                shape.proxy_pool = raw.split(',').map(entry => entry.trim()).filter(Boolean);
                return;
            }
            shape.proxy_pool = [];
        },
        serialize: (shape) => {
            const pool = getStringArray(shape, 'proxy_pool');
            return pool.length === 0 ? '' : JSON.stringify(pool);
        },
    },
    {
        envName: 'PROXY_SUBSCRIPTIONS',
        apply: (shape, raw) => {
            if (!raw) {
                return;
            }
            try {
                shape.proxy_subscriptions = parseProxySubscriptions(JSON.parse(raw), getProxySubscriptionRefreshMs(shape)).map(subscription => ({
                    name: subscription.name,
                    url: subscription.url,
                    enabled: subscription.enabled,
                    refresh_interval_ms: subscription.refreshIntervalMs,
                    format: subscription.format,
                }));
            } catch {
                shape.proxy_subscriptions = [];
            }
        },
        serialize: (shape) => {
            const subscriptions = getNormalizedProxySubscriptions(shape);
            return subscriptions.length === 0 ? '' : JSON.stringify(subscriptions);
        },
    },
    {
        envName: 'AIRPORT_SUBSCRIPTIONS',
        apply: (shape, raw) => {
            if (!raw) {
                return;
            }
            try {
                shape.airport_subscriptions = parseAirportSubscriptions(JSON.parse(raw)).map(subscription => ({
                    name: subscription.name,
                    url: subscription.url,
                    enabled: subscription.enabled,
                    interval_seconds: subscription.intervalSeconds,
                    filter: subscription.filter,
                    exclude_filter: subscription.excludeFilter,
                    exclude_type: subscription.excludeType,
                    headers: subscription.headers,
                }));
            } catch {
                shape.airport_subscriptions = [];
            }
        },
        serialize: (shape) => {
            const subscriptions = getNormalizedAirportSubscriptions(shape);
            return subscriptions.length === 0 ? '' : JSON.stringify(subscriptions);
        },
    },
    {
        envName: 'FP',
        apply: (shape, raw) => {
            if (!raw) {
                return;
            }
            try {
                const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf-8'));
                const record = toRecord(parsed);
                if (record && typeof record.userAgent === 'string' && record.userAgent.trim()) {
                    shape.fingerprint = { user_agent: record.userAgent };
                }
            } catch {
            }
        },
        serialize: (shape) => {
            const userAgent = getFingerprintUserAgent(shape).trim();
            return userAgent ? Buffer.from(JSON.stringify({ userAgent }), 'utf-8').toString('base64') : '';
        },
    },
];

function applyPersistedEnv(shape: ConfigShape, envValues: EnvFileValues): void {
    for (const binding of ENV_BINDINGS) {
        if (!Object.prototype.hasOwnProperty.call(envValues, binding.envName)) {
            continue;
        }

        binding.apply(shape, envValues[binding.envName] ?? '');
    }
}

async function readPersistedConfigShape(): Promise<ConfigShape> {
    const shape = runtimeToShape(createDefaultConfig());
    const configPath = getAdminConfigPath();
    const envPath = getAdminEnvFilePath();

    try {
        const raw = await readFile(configPath, 'utf-8');
        const parsed = parseYaml(raw);
        const persisted = toRecord(parsed);
        if (persisted) {
            applyPersistedConfig(shape, persisted);
        }
    } catch (err) {
        if (getErrorCode(err) !== 'ENOENT') {
            throw err;
        }
    }

    if (envPath) {
        try {
            const raw = await readFile(envPath, 'utf-8');
            applyPersistedEnv(shape, parseDotenv(raw));
        } catch (err) {
            if (getErrorCode(err) !== 'ENOENT') {
                throw err;
            }
        }
    }

    return shape;
}

function buildEnvAssignments(shape: ConfigShape): Map<string, string> {
    const assignments = new Map<string, string>();
    for (const binding of ENV_BINDINGS) {
        assignments.set(binding.envName, binding.serialize(shape));
    }
    return assignments;
}

async function buildUpdatedEnvFileContent(shape: ConfigShape, envPath: string): Promise<string> {
    let currentContent = '';

    try {
        currentContent = await readFile(envPath, 'utf-8');
    } catch (err) {
        if (getErrorCode(err) !== 'ENOENT') {
            throw err;
        }
    }

    const assignments = buildEnvAssignments(shape);
    const seen = new Set<string>();
    const sourceLines = currentContent ? currentContent.split(/\r?\n/) : [];
    const nextLines = sourceLines.map((line) => {
        const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)=(.*)$/);
        if (!match) {
            return line;
        }

        const [, leading, key, spacing] = match;
        const nextValue = assignments.get(key);
        if (nextValue === undefined) {
            return line;
        }

        seen.add(key);
        return `${leading}${key}${spacing}=${nextValue}`;
    });

    for (const [key, value] of assignments) {
        if (seen.has(key) || value === '') {
            continue;
        }

        nextLines.push(`${key}=${value}`);
    }

    return nextLines.join('\n');
}

function buildSaveMessage(envPath: string | null): string {
    if (envPath) {
        return '配置已保存；涉及 .env.docker 的变更需执行 docker compose up -d --force-recreate。';
    }

    return '配置文件已保存，重启服务后生效。';
}

function formatPersistenceWriteError(targetPath: string, err: unknown): string {
    const code = getErrorCode(err);
    const message = err instanceof Error ? err.message : String(err);

    if (code === 'EROFS') {
        return `配置文件不可写：${targetPath}。如果你使用 Docker Compose，请确认没有把该文件以只读方式挂载（例如移除 :ro）。原始错误：${message}`;
    }

    if (code === 'EACCES' || code === 'EPERM') {
        return `配置文件没有写入权限：${targetPath}。请检查宿主机文件权限或属主，确保容器内运行用户可以写入；如果使用 Docker Compose，也请确认没有把该文件以只读方式挂载。原始错误：${message}`;
    }

    return message;
}

export async function handleGetConfig(_req: Request, res: Response): Promise<void> {
    const configPath = getAdminConfigPath();
    const envPath = getAdminEnvFilePath();

    try {
        const config = await readPersistedConfigShape();
        res.json({ ok: true, config, path: configPath, envPath });
    } catch (err) {
        res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err), path: configPath, envPath });
    }
}

export async function handlePostConfig(req: Request, res: Response): Promise<void> {
    const updates = req.body as Record<string, unknown>;
    const configPath = getAdminConfigPath();
    const envPath = getAdminEnvFilePath();

    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        res.status(400).json({ ok: false, error: 'Body must be a JSON object', path: configPath, envPath });
        return;
    }

    const current = await readPersistedConfigShape();

    for (const [key, value] of Object.entries(updates)) {
        if (ALLOWED_SCALAR_KEYS.has(key)) {
            current[key] = value;
        } else if (ALLOWED_OBJECT_KEYS.has(key)) {
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                current[key] = { ...(current[key] as Record<string, unknown> ?? {}), ...(value as Record<string, unknown>) };
            }
        } else if (ALLOWED_ARRAY_KEYS.has(key)) {
            if (Array.isArray(value)) {
                current[key] = value;
            }
        }
    }

    try {
        if (envPath) {
            const envContent = await buildUpdatedEnvFileContent(current, envPath);
            await writeFile(envPath, envContent, 'utf-8');
        }
    } catch (err) {
        res.status(500).json({ ok: false, error: formatPersistenceWriteError(envPath ?? getAdminConfigPath(), err), path: configPath, envPath });
        return;
    }

    try {
        await writeFile(configPath, stringifyYaml(current), 'utf-8');
        res.json({
            ok: true,
            message: buildSaveMessage(envPath),
            config: current,
            path: configPath,
            envPath,
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: formatPersistenceWriteError(configPath, err), path: configPath, envPath });
    }
}

export function handleGetRunningConfig(_req: Request, res: Response): void {
    res.json({ ok: true, config: getConfig(), envPath: getAdminEnvFilePath() });
}
