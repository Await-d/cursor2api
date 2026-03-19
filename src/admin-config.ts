import { writeFile } from 'fs/promises';
import { stringify as stringifyYaml } from 'yaml';
import type { Request, Response } from 'express';
import { getConfig } from './config.js';

const CONFIG_PATH = 'config.yaml';

function runtimeToShape(cfg: ReturnType<typeof getConfig>): Record<string, unknown> {
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
            name: s.name, url: s.url, enabled: s.enabled,
            refresh_interval_ms: s.refreshIntervalMs, format: s.format,
        })),
        airport_subscriptions: cfg.airportSubscriptions.map(s => ({
            name: s.name, url: s.url, enabled: s.enabled,
            interval_seconds: s.intervalSeconds, filter: s.filter,
            exclude_filter: s.excludeFilter, exclude_type: s.excludeType, headers: s.headers,
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

export function handleGetConfig(_req: Request, res: Response): void {
    res.json({ ok: true, config: runtimeToShape(getConfig()) });
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

export async function handlePostConfig(req: Request, res: Response): Promise<void> {
    const updates = req.body as Record<string, unknown>;
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        res.status(400).json({ ok: false, error: 'Body must be a JSON object' });
        return;
    }

    const current = runtimeToShape(getConfig());

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

    const yamlKeys: Record<string, string> = {
        cursor_model: 'cursor_model',
        queue_timeout: 'queue_timeout',
        retry_delay: 'retry_delay',
        max_retry_delay: 'max_retry_delay',
    };
    void yamlKeys;

    try {
        await writeFile(CONFIG_PATH, stringifyYaml(current), 'utf-8');
        res.json({ ok: true, message: 'config.yaml 已更新，重启后生效。' });
    } catch (err) {
        res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
}

export function handleGetRunningConfig(_req: Request, res: Response): void {
    res.json({ ok: true, config: getConfig() });
}
