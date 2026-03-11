import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { AppConfig } from './types.js';

let config: AppConfig;

function parseModelMapping(raw: unknown): Record<string, string> {
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

export function resolveCursorModel(requestedModel?: string): string {
    const { cursorModel, modelMapping } = getConfig();

    if (!requestedModel) {
        return modelMapping['*'] || cursorModel;
    }

    return modelMapping[requestedModel] || modelMapping['*'] || cursorModel;
}

export function getConfig(): AppConfig {
    if (config) return config;

    // 默认配置
    config = {
        port: 3010,
        timeout: 120,
        cursorModel: 'anthropic/claude-sonnet-4.6',
        concurrency: 3,
        queueTimeout: 120_000,
        retryDelay: 5_000,
        maxRetryDelay: 60_000,
        modelMapping: {},
        systemPromptInject: '',
        proxyPool: [],
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        },
    };

    // 从 config.yaml 加载
    if (existsSync('config.yaml')) {
        try {
            const raw = readFileSync('config.yaml', 'utf-8');
            const yaml = parseYaml(raw);
            if (yaml.port) config.port = yaml.port;
            if (yaml.timeout) config.timeout = yaml.timeout;
            if (yaml.proxy) config.proxy = yaml.proxy;
            if (yaml.cursor_model) config.cursorModel = yaml.cursor_model;
            if (yaml.concurrency) config.concurrency = yaml.concurrency;
            if (yaml.queue_timeout) config.queueTimeout = yaml.queue_timeout;
            if (yaml.retry_delay) config.retryDelay = yaml.retry_delay;
            if (yaml.max_retry_delay) config.maxRetryDelay = yaml.max_retry_delay;
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
        } catch (e) {
            console.warn('[Config] 读取 config.yaml 失败:', e);
        }
    }

    // 环境变量覆盖
    if (process.env.PORT) config.port = parseInt(process.env.PORT);
    if (process.env.TIMEOUT) config.timeout = parseInt(process.env.TIMEOUT);
    if (process.env.PROXY) config.proxy = process.env.PROXY;
    if (process.env.CURSOR_MODEL) config.cursorModel = process.env.CURSOR_MODEL;
    if (process.env.CONCURRENCY) config.concurrency = parseInt(process.env.CONCURRENCY);
    if (process.env.QUEUE_TIMEOUT) config.queueTimeout = parseInt(process.env.QUEUE_TIMEOUT);
    if (process.env.RETRY_DELAY) config.retryDelay = parseInt(process.env.RETRY_DELAY);
    if (process.env.MAX_RETRY_DELAY) config.maxRetryDelay = parseInt(process.env.MAX_RETRY_DELAY);
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

    // 从 base64 FP 环境变量解析指纹
    if (process.env.FP) {
        try {
            const fp = JSON.parse(Buffer.from(process.env.FP, 'base64').toString());
            if (fp.userAgent) config.fingerprint.userAgent = fp.userAgent;
        } catch (e) {
            console.warn('[Config] 解析 FP 环境变量失败:', e);
        }
    }

    return config;
}
