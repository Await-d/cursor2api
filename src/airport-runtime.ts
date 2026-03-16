import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { Socket, createServer } from 'net';
import { spawn, type ChildProcess } from 'child_process';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { getConfig } from './config.js';
import { setRuntimeProxyPool } from './proxy-subscriptions.js';
import type { AirportSubscriptionConfig } from './types.js';

export interface AirportRuntimeBinding {
    endpoint: string;
    groupName: string;
    label: string;
    port: number;
    providerNames: string[];
    subscriptions: AirportSubscriptionConfig[];
    groupFilter?: string;
    groupExcludeFilter?: string;
    groupExcludeType?: string;
}

export interface AirportRuntimeSnapshot {
    enabled: boolean;
    running: boolean;
    mode: 'auto' | 'combined' | 'per-subscription';
    binaryPath: string;
    endpoint: string | null;
    endpoints: string[];
    workDir: string;
    bindingCount: number;
    subscriptionCount: number;
    lastError: string | null;
    lastStartedAt: string | null;
    pid: number | null;
    bindings: Array<{
        endpoint: string;
        groupName: string;
        label: string;
        port: number;
        sources: string[];
    }>;
    subscriptions: Array<{
        name: string;
        source: string;
        intervalSeconds: number;
        enabled: boolean;
    }>;
}

const RUNTIME_GROUP_NAME = 'cursor2api-airport';
const AUTO_COMMON_EXCLUDE_PATTERN = '剩余流量|到期时间|emby|资源服|教学服|porn|国内|永久';
const AUTO_COMMON_EXCLUDE_FILTER = `(?i)${AUTO_COMMON_EXCLUDE_PATTERN}`;

const AUTO_REGION_RULES = [
    { key: 'hk', label: 'auto-hk', detect: /(香港|hk|hong ?kong|🇭🇰)/i, filter: '(?i)香港|hk|hong ?kong|🇭🇰' },
    { key: 'us', label: 'auto-us', detect: /(美国|us|usa|united states|洛杉矶|西雅图|圣何塞|芝加哥|纽约|🇺🇸)/i, filter: '(?i)美国|us|usa|united states|洛杉矶|西雅图|圣何塞|芝加哥|纽约|🇺🇸' },
    { key: 'tw', label: 'auto-tw', detect: /(台湾|tw|taiwan|台北|🇹🇼)/i, filter: '(?i)台湾|tw|taiwan|台北|🇹🇼' },
    { key: 'jp', label: 'auto-jp', detect: /(日本|jp|japan|东京|大阪|🇯🇵)/i, filter: '(?i)日本|jp|japan|东京|大阪|🇯🇵' },
    { key: 'sg', label: 'auto-sg', detect: /(新加坡|sg|singapore|🇸🇬)/i, filter: '(?i)新加坡|sg|singapore|🇸🇬' },
];
const AUTO_REGION_EXCLUDE_PATTERN = '香港|hk|hong ?kong|🇭🇰|美国|us|usa|united states|洛杉矶|西雅图|圣何塞|芝加哥|纽约|🇺🇸|台湾|tw|taiwan|台北|🇹🇼|日本|jp|japan|东京|大阪|🇯🇵|新加坡|sg|singapore|🇸🇬';

let mihomoProcess: ChildProcess | null = null;
let currentEndpoints: string[] = [];
let currentBindings: AirportRuntimeBinding[] = [];
let lastError: string | null = null;
let lastStartedAt: number | null = null;
let restartDelayMs = 3_000;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let stopping = false;
let handlersRegistered = false;

function maskSubscriptionUrl(raw: string): string {
    try {
        const url = new URL(raw);
        return `${url.protocol}//${url.host}${url.pathname && url.pathname !== '/' ? '/***' : ''}`;
    } catch {
        return raw;
    }
}

function sanitizeRuntimeLog(text: string): string {
    return text
        .replace(/https?:\/\/[^\s]+/gi, (match) => maskSubscriptionUrl(match))
        .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1***')
        .replace(/(token\s*[:=]\s*)[^\s,;]+/gi, '$1***');
}

function subscriptionLabel(subscription: AirportSubscriptionConfig): string {
    const name = subscription.name.trim();
    const url = subscription.url.trim();
    if (!name || name === url) {
        return maskSubscriptionUrl(url);
    }

    return name;
}

function sanitizeSegment(value: string, fallbackIndex: number): string {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
    return normalized || `binding-${fallbackIndex}`;
}

function toIso(value: number | null): string | null {
    return value ? new Date(value).toISOString() : null;
}

function normalizeSubscriptionUrl(raw: string): string {
    const trimmed = raw.trim();
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Airport subscription URLs must use http/https');
    }

    return trimmed;
}

function buildProviderName(index: number): string {
    return `airport_provider_${index + 1}`;
}

function buildProviderPath(index: number): string {
    return `./providers/provider-${index + 1}.yaml`;
}

function buildProviderHeader(headers: Record<string, string>): Record<string, string[]> | undefined {
    const entries = Object.entries(headers);
    if (entries.length === 0) {
        return undefined;
    }

    return Object.fromEntries(entries.map(([key, value]) => [key, [value]]));
}

function buildAirportRuntimeEndpoint(port: number): string {
    return `socks5://127.0.0.1:${port}`;
}

function dedupe(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        result.push(trimmed);
    }
    return result;
}

function injectRuntimeEndpoints(endpoints: string[]): void {
    setRuntimeProxyPool(endpoints);
}

function buildGroupConfig(binding: AirportRuntimeBinding): Record<string, unknown> {
    const config = getConfig();
    const group: Record<string, unknown> = {
        name: binding.groupName,
        type: config.airportRuntimeGroupType,
        use: binding.providerNames,
        url: config.airportRuntimeTestUrl,
        interval: config.airportRuntimeTestIntervalSeconds,
        lazy: true,
    };

    if (config.airportRuntimeGroupType === 'load-balance' && config.airportRuntimeGroupStrategy) {
        group.strategy = config.airportRuntimeGroupStrategy;
    }

    if (binding.groupFilter) {
        group.filter = binding.groupFilter;
    }
    if (binding.groupExcludeFilter) {
        group['exclude-filter'] = binding.groupExcludeFilter;
    }
    if (binding.groupExcludeType) {
        group['exclude-type'] = binding.groupExcludeType;
    }

    return group;
}

function hasManualSegmentation(subscription: AirportSubscriptionConfig): boolean {
    return Boolean(subscription.filter || subscription.excludeFilter || subscription.excludeType);
}

function decodeMaybeBase64Subscription(payload: string): string {
    const compact = payload.replace(/\s+/g, '');
    if (!compact || /:\/\//.test(payload)) {
        return payload;
    }

    if (!/^[A-Za-z0-9+/_=-]+$/.test(compact)) {
        return payload;
    }

    try {
        const normalized = compact.replace(/-/g, '+').replace(/_/g, '/');
        const padded = normalized.padEnd(normalized.length + ((4 - normalized.length % 4) % 4), '=');
        const decoded = Buffer.from(padded, 'base64').toString('utf8');
        return /:\/\//.test(decoded) || /proxies:|outbounds:|\{/.test(decoded) ? decoded : payload;
    } catch {
        return payload;
    }
}

function extractNameFromUriLine(line: string): string {
    const hashIndex = line.indexOf('#');
    if (hashIndex >= 0) {
        try {
            return decodeURIComponent(line.slice(hashIndex + 1));
        } catch {
            return line.slice(hashIndex + 1);
        }
    }

    const groupMatch = line.match(/[?&]group=([^&]+)/);
    if (groupMatch) {
        try {
            return decodeURIComponent(groupMatch[1]);
        } catch {
            return groupMatch[1];
        }
    }

    if (line.startsWith('vmess://')) {
        try {
            const payload = Buffer.from(line.slice('vmess://'.length), 'base64').toString('utf8');
            const parsed = JSON.parse(payload) as Record<string, unknown>;
            return typeof parsed.ps === 'string' ? parsed.ps : '';
        } catch {
            return '';
        }
    }

    return '';
}

function extractAirportNodeNamesFromStructuredValue(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.flatMap((item) => extractAirportNodeNamesFromStructuredValue(item));
    }

    if (!value || typeof value !== 'object') {
        return [];
    }

    const record = value as Record<string, unknown>;
    const directName = typeof record.name === 'string' ? [record.name] : [];
    const nested = Object.values(record).flatMap((item) => extractAirportNodeNamesFromStructuredValue(item));
    return [...directName, ...nested];
}

function extractAirportNodeNames(payload: string): string[] {
    const normalized = decodeMaybeBase64Subscription(payload.trim());
    if (!normalized) {
        return [];
    }

    if (/^\s*(?:\{|\[|proxies:|outbounds:)/im.test(normalized)) {
        try {
            const structured = /^\s*[\[{]/.test(normalized) ? JSON.parse(normalized) : parseYaml(normalized);
            return dedupe(extractAirportNodeNamesFromStructuredValue(structured).map((name) => name.trim()).filter(Boolean));
        } catch {
        }
    }

    return dedupe(normalized
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => extractNameFromUriLine(line))
        .map((name) => name.trim())
        .filter(Boolean));
}

async function fetchAirportNodeNames(subscription: AirportSubscriptionConfig): Promise<string[]> {
    const config = getConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.proxySubscriptionTimeoutMs);

    try {
        const response = await fetch(normalizeSubscriptionUrl(subscription.url), {
            signal: controller.signal,
            headers: {
                'user-agent': config.fingerprint.userAgent,
                ...subscription.headers,
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to inspect airport subscription: HTTP ${response.status}`);
        }

        const text = await readResponseTextWithLimit(response, config.proxySubscriptionMaxBytes);
        return extractAirportNodeNames(text);
    } finally {
        clearTimeout(timer);
    }
}

function buildPerSubscriptionBindings(subscriptions: AirportSubscriptionConfig[]): AirportRuntimeBinding[] {
    const config = getConfig();
    return subscriptions.map((subscription, index) => {
        const providerName = buildProviderName(index);
        const label = subscriptionLabel(subscription);
        const segment = sanitizeSegment(label, index + 1);
        const port = config.airportRuntimeSocksPort + index * 2;
        return {
            endpoint: buildAirportRuntimeEndpoint(port),
            groupName: `${RUNTIME_GROUP_NAME}-${segment}-${index + 1}`,
            label,
            port,
            providerNames: [providerName],
            subscriptions: [subscription],
        };
    });
}

function buildCombinedBindings(subscriptions: AirportSubscriptionConfig[]): AirportRuntimeBinding[] {
    const config = getConfig();
    return [{
        endpoint: buildAirportRuntimeEndpoint(config.airportRuntimeSocksPort),
        groupName: `${RUNTIME_GROUP_NAME}-combined`,
        label: 'combined',
        port: config.airportRuntimeSocksPort,
        providerNames: subscriptions.map((_subscription, index) => buildProviderName(index)),
        subscriptions,
    }];
}

export function buildAutoAirportRuntimeBindings(
    subscriptions: AirportSubscriptionConfig[],
    nodeNames: string[],
): AirportRuntimeBinding[] {
    const config = getConfig();
    if (subscriptions.length !== 1) {
        return buildPerSubscriptionBindings(subscriptions);
    }

    const subscription = subscriptions[0];
    const buckets = AUTO_REGION_RULES.map((rule) => ({
        ...rule,
        count: nodeNames.filter((name) => rule.detect.test(name) && !new RegExp(AUTO_COMMON_EXCLUDE_PATTERN, 'i').test(name)).length,
    })).filter((bucket) => bucket.count > 0);

    const bindings: AirportRuntimeBinding[] = buckets.map((bucket, index) => ({
        endpoint: buildAirportRuntimeEndpoint(config.airportRuntimeSocksPort + index * 2),
        groupName: `${RUNTIME_GROUP_NAME}-${bucket.key}-${index + 1}`,
        label: bucket.label,
        port: config.airportRuntimeSocksPort + index * 2,
        providerNames: [buildProviderName(0)],
        subscriptions: [subscription],
        groupFilter: bucket.filter,
        groupExcludeFilter: AUTO_COMMON_EXCLUDE_FILTER,
    }));

    const knownRegionCount = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
    const otherCount = nodeNames.filter((name) => !new RegExp(AUTO_COMMON_EXCLUDE_PATTERN, 'i').test(name)).length - knownRegionCount;
    if (otherCount > 0) {
        bindings.push({
            endpoint: buildAirportRuntimeEndpoint(config.airportRuntimeSocksPort + bindings.length * 2),
            groupName: `${RUNTIME_GROUP_NAME}-other-${bindings.length + 1}`,
            label: 'auto-other',
            port: config.airportRuntimeSocksPort + bindings.length * 2,
            providerNames: [buildProviderName(0)],
            subscriptions: [subscription],
            groupExcludeFilter: `(?i)${AUTO_COMMON_EXCLUDE_PATTERN}|${AUTO_REGION_EXCLUDE_PATTERN}`,
        });
    }

    return bindings.length > 1 ? bindings : buildCombinedBindings(subscriptions);
}

export function buildAirportRuntimeBindings(
    subscriptions: AirportSubscriptionConfig[] = getConfig().airportSubscriptions.filter((subscription) => subscription.enabled),
): AirportRuntimeBinding[] {
    const config = getConfig();
    const enabledSubscriptions = subscriptions.filter((subscription) => subscription.enabled);
    if (enabledSubscriptions.length === 0) {
        return [];
    }

    if (config.airportRuntimeMode === 'per-subscription') {
        return buildPerSubscriptionBindings(enabledSubscriptions);
    }

    return buildCombinedBindings(enabledSubscriptions);
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
    if (!response.body) {
        return '';
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;

        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
            await reader.cancel();
            throw new Error(`Airport subscription payload exceeded ${maxBytes} bytes`);
        }

        chunks.push(value);
    }

    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return new TextDecoder().decode(merged);
}

export async function resolveAirportRuntimeBindings(subscriptions: AirportSubscriptionConfig[]): Promise<AirportRuntimeBinding[]> {
    const config = getConfig();
    const enabledSubscriptions = subscriptions.filter((subscription) => subscription.enabled);
    if (enabledSubscriptions.length === 0) {
        return [];
    }

    if (config.airportRuntimeMode !== 'auto') {
        return buildAirportRuntimeBindings(enabledSubscriptions);
    }

    if (enabledSubscriptions.length !== 1 || enabledSubscriptions.some(hasManualSegmentation)) {
        console.log('[AirportRuntime] auto 模式检测到多订阅或显式过滤规则，保留 per-subscription 行为');
        return buildPerSubscriptionBindings(enabledSubscriptions);
    }

    try {
        const nodeNames = await fetchAirportNodeNames(enabledSubscriptions[0]);
        return buildAutoAirportRuntimeBindings(enabledSubscriptions, nodeNames);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[AirportRuntime] 自动分组分析失败，回退为 combined 模式: ${reason}`);
        return buildCombinedBindings(enabledSubscriptions);
    }
}

export function buildMihomoConfigDocument(
    subscriptions: AirportSubscriptionConfig[],
    bindings = buildAirportRuntimeBindings(subscriptions),
): string {
    const config = getConfig();
    const enabledSubscriptions = subscriptions.filter((subscription) => subscription.enabled);
    const proxyProviders = Object.fromEntries(enabledSubscriptions.map((subscription, index) => {
        const provider: Record<string, unknown> = {
            type: 'http',
            url: normalizeSubscriptionUrl(subscription.url),
            path: buildProviderPath(index),
            interval: subscription.intervalSeconds,
            'size-limit': config.proxySubscriptionMaxBytes,
            'health-check': {
                enable: true,
                url: config.airportRuntimeTestUrl,
                interval: config.airportRuntimeTestIntervalSeconds,
                timeout: 5_000,
                lazy: true,
            },
        };

        const header = buildProviderHeader(subscription.headers);
        if (header) {
            provider.header = header;
        }
        if (subscription.filter) {
            provider.filter = subscription.filter;
        }
        if (subscription.excludeFilter) {
            provider['exclude-filter'] = subscription.excludeFilter;
        }
        if (subscription.excludeType) {
            provider['exclude-type'] = subscription.excludeType;
        }

        return [buildProviderName(index), provider];
    }));

    const listeners = config.airportRuntimeMode === 'per-subscription' || config.airportRuntimeMode === 'auto'
        ? bindings.map((binding, index) => ({
            name: `airport-listener-${index + 1}`,
            type: 'socks',
            port: binding.port,
            listen: '127.0.0.1',
            proxy: binding.groupName,
        }))
        : undefined;

    const document: Record<string, unknown> = {
        'allow-lan': false,
        mode: 'rule',
        'log-level': config.airportRuntimeLogLevel,
        'external-controller': `127.0.0.1:${config.airportRuntimeControlPort}`,
        profile: {
            'store-selected': true,
        },
        'proxy-providers': proxyProviders,
        'proxy-groups': bindings.map((binding) => buildGroupConfig(binding)),
        rules: [config.airportRuntimeMode === 'per-subscription' || config.airportRuntimeMode === 'auto' ? 'MATCH,DIRECT' : `MATCH,${bindings[0]?.groupName ?? `${RUNTIME_GROUP_NAME}-combined`}`],
    };

    if (config.airportRuntimeMode === 'per-subscription' || config.airportRuntimeMode === 'auto') {
        document.listeners = listeners;
    } else {
        document['socks-port'] = bindings[0]?.port ?? config.airportRuntimeSocksPort;
        document['bind-address'] = '127.0.0.1';
    }

    return stringifyYaml(document);
}

function ensureRuntimeHandlers(): void {
    if (handlersRegistered) {
        return;
    }

    handlersRegistered = true;
    const stop = () => {
        void stopAirportRuntime();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.once('exit', stop);
}

function scheduleRestart(): void {
    if (stopping || restartTimer) {
        return;
    }

    const delay = restartDelayMs;
    restartTimer = setTimeout(() => {
        restartTimer = null;
        void startAirportRuntime();
    }, delay);
    restartDelayMs = Math.min(restartDelayMs * 2, 30_000);
}

function waitForSocksPort(port: number, timeoutMs = 15_000): Promise<void> {
    const startedAt = Date.now();

    return new Promise((resolvePromise, reject) => {
        const attempt = () => {
            const socket = new Socket();

            const finalize = (error?: Error) => {
                socket.removeAllListeners();
                socket.destroy();
                if (!error) {
                    resolvePromise();
                    return;
                }

                if (Date.now() - startedAt >= timeoutMs) {
                    reject(error);
                    return;
                }

                setTimeout(attempt, 250);
            };

            socket.once('connect', () => finalize());
            socket.once('error', (error) => finalize(error instanceof Error ? error : new Error(String(error))));
            socket.connect(port, '127.0.0.1');
        };

        attempt();
    });
}

function ensureLocalPortAvailable(port: number): Promise<void> {
    return new Promise((resolvePromise, reject) => {
        const server = createServer();

        server.once('error', (error) => {
            server.close();
            reject(error instanceof Error ? error : new Error(String(error)));
        });

        server.listen(port, '127.0.0.1', () => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolvePromise();
            });
        });
    });
}

function ensureDistinctPorts(bindings: AirportRuntimeBinding[]): void {
    const config = getConfig();
    const ports = new Set<number>();
    const values = [...bindings.map((binding) => binding.port), config.airportRuntimeControlPort];
    for (const port of values) {
        if (ports.has(port)) {
            throw new Error(`Airport runtime port collision detected on ${port}`);
        }
        ports.add(port);
    }
}

async function launchMihomo(configPath: string, bindings: AirportRuntimeBinding[]): Promise<void> {
    const config = getConfig();
    const binaryPath = config.airportRuntimeBinaryPath;

    await new Promise<void>((resolvePromise, reject) => {
        let settled = false;
        const child = spawn(binaryPath, ['-d', config.airportRuntimeWorkDir, '-f', configPath], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        mihomoProcess = child;

        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };

        child.once('error', (error) => {
            fail(error instanceof Error ? error : new Error(String(error)));
        });

        child.stdout?.on('data', (chunk) => {
            const text = sanitizeRuntimeLog(String(chunk).trim());
            if (text) {
                console.log(`[AirportRuntime] ${text}`);
            }
        });

        child.stderr?.on('data', (chunk) => {
            const text = sanitizeRuntimeLog(String(chunk).trim());
            if (text) {
                console.warn(`[AirportRuntime] ${text}`);
            }
        });

        child.once('exit', (code, signal) => {
            mihomoProcess = null;
            currentEndpoints = [];
            currentBindings = [];
            setRuntimeProxyPool([]);
            if (!settled) {
                settled = true;
                reject(new Error(`Mihomo exited before ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
                return;
            }

            lastError = `Mihomo exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
            console.warn(`[AirportRuntime] ${lastError}`);
            scheduleRestart();
        });

        Promise.all(bindings.map((binding) => waitForSocksPort(binding.port))).then(() => {
            if (settled) return;
            settled = true;
            resolvePromise();
        }).catch((error) => {
            fail(error instanceof Error ? error : new Error(String(error)));
        });
    });
}

async function startAirportRuntime(): Promise<void> {
    const config = getConfig();
    const subscriptions = config.airportSubscriptions.filter((subscription) => subscription.enabled);
    if (subscriptions.length === 0) {
        return;
    }
    if (mihomoProcess) {
        return;
    }

    ensureRuntimeHandlers();
    const bindings = await resolveAirportRuntimeBindings(subscriptions);
    ensureDistinctPorts(bindings);
    const workDir = resolve(config.airportRuntimeWorkDir);
    mkdirSync(resolve(workDir, 'providers'), { recursive: true });
    const configPath = resolve(workDir, 'config.yaml');
    writeFileSync(configPath, buildMihomoConfigDocument(subscriptions, bindings), 'utf-8');
    await Promise.all([
        ...bindings.map((binding) => ensureLocalPortAvailable(binding.port)),
        ensureLocalPortAvailable(config.airportRuntimeControlPort),
    ]);

    try {
        await launchMihomo(configPath, bindings);
        currentBindings = bindings;
        currentEndpoints = bindings.map((binding) => binding.endpoint);
        injectRuntimeEndpoints(currentEndpoints);
        lastStartedAt = Date.now();
        lastError = null;
        restartDelayMs = 3_000;
        console.log(`[AirportRuntime] 已启动 Mihomo，本地代理入口 ${currentEndpoints.join(', ')}`);
    } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        console.error(`[AirportRuntime] 启动失败: ${lastError}`);
        scheduleRestart();
        throw error;
    }
}

export async function initAirportRuntime(): Promise<AirportRuntimeSnapshot> {
    const config = getConfig();
    if (!config.airportSubscriptions.some((subscription) => subscription.enabled)) {
        return getAirportRuntimeSnapshot();
    }

    await startAirportRuntime();
    return getAirportRuntimeSnapshot();
}

export function getAirportRuntimeSnapshot(): AirportRuntimeSnapshot {
    const config = getConfig();
    const enabledSubscriptions = config.airportSubscriptions.filter((subscription) => subscription.enabled);
    const bindings = currentBindings.length > 0 ? currentBindings : buildAirportRuntimeBindings(enabledSubscriptions);
    const bindingSnapshots = bindings.map((binding) => ({
        endpoint: binding.endpoint,
        groupName: binding.groupName,
        label: binding.label,
        port: binding.port,
        sources: binding.subscriptions.map((subscription) => maskSubscriptionUrl(subscription.url)),
    }));
    const subscriptions = config.airportSubscriptions.map((subscription) => ({
        name: subscriptionLabel(subscription),
        source: maskSubscriptionUrl(subscription.url),
        intervalSeconds: subscription.intervalSeconds,
        enabled: subscription.enabled,
    }));

    return {
        enabled: enabledSubscriptions.length > 0,
        running: Boolean(mihomoProcess && currentEndpoints.length > 0),
        mode: config.airportRuntimeMode,
        binaryPath: config.airportRuntimeBinaryPath,
        endpoint: currentEndpoints[0] ?? null,
        endpoints: [...currentEndpoints],
        workDir: resolve(config.airportRuntimeWorkDir),
        bindingCount: bindingSnapshots.length,
        subscriptionCount: enabledSubscriptions.length,
        lastError,
        lastStartedAt: toIso(lastStartedAt),
        pid: mihomoProcess?.pid ?? null,
        bindings: bindingSnapshots,
        subscriptions,
    };
}

export async function stopAirportRuntime(): Promise<void> {
    stopping = true;
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
    }
    if (!mihomoProcess) {
        return;
    }

    await new Promise<void>((resolvePromise) => {
        const child = mihomoProcess;
        if (!child) {
            resolvePromise();
            return;
        }

        child.once('exit', () => {
            mihomoProcess = null;
            currentEndpoints = [];
            currentBindings = [];
            setRuntimeProxyPool([]);
            resolvePromise();
        });
        child.kill('SIGTERM');
        setTimeout(() => {
            if (mihomoProcess) {
                mihomoProcess.kill('SIGKILL');
            }
        }, 5_000);
    });
}
