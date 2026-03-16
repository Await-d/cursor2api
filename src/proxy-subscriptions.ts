import { parse as parseYaml } from 'yaml';
import { getConfig } from './config.js';
import type { ProxySubscriptionConfig } from './types.js';

type ProxySubscriptionStatus = 'idle' | 'loading' | 'ready' | 'error' | 'disabled';

interface ProxySubscriptionRuntimeState {
    id: string;
    config: ProxySubscriptionConfig;
    status: ProxySubscriptionStatus;
    importedProxyUrls: string[];
    lastFetchedAt?: number;
    lastSuccessAt?: number;
    lastErrorAt?: number;
    lastError?: string;
    nextRefreshAt?: number;
}

export interface ProxySubscriptionSummary {
    id: string;
    name: string;
    source: string;
    enabled: boolean;
    format: ProxySubscriptionConfig['format'];
    refreshIntervalMs: number;
    status: ProxySubscriptionStatus;
    importedCount: number;
    lastFetchedAt: string | null;
    lastSuccessAt: string | null;
    lastErrorAt: string | null;
    lastError: string | null;
    nextRefreshAt: string | null;
}

export interface ProxySubscriptionSnapshot {
    enabled: boolean;
    subscriptionCount: number;
    importedProxyCount: number;
    totalProxyCount: number;
    subscriptions: ProxySubscriptionSummary[];
}

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks5:', 'socks5h:']);

const runtimeStates = new Map<string, ProxySubscriptionRuntimeState>();
const refreshTimers = new Map<string, ReturnType<typeof setInterval>>();

let baseProxyPool: string[] | null = null;
let runtimeProxyPool: string[] = [];
let reloadPromise: Promise<ProxySubscriptionSnapshot> | null = null;

function subscriptionId(subscription: ProxySubscriptionConfig): string {
    return `${subscription.name}::${subscription.url}`;
}

function dedupeStrings(values: string[]): string[] {
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

function maskSubscriptionUrl(raw: string): string {
    try {
        const url = new URL(raw);
        return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
        return raw;
    }
}

function displaySubscriptionName(subscription: ProxySubscriptionConfig): string {
    const name = subscription.name.trim();
    const url = subscription.url.trim();
    if (!name || name === url) {
        return maskSubscriptionUrl(url);
    }

    return name;
}

function toIso(value?: number): string | null {
    return value ? new Date(value).toISOString() : null;
}

function summarizeError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}

export function validateSubscriptionUrl(raw: string): string {
    const trimmed = raw.trim();
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Only http/https subscription URLs are supported');
    }

    return trimmed;
}

function normalizeProxyUrl(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    try {
        const url = new URL(trimmed);
        return SUPPORTED_PROTOCOLS.has(url.protocol) ? trimmed : null;
    } catch {
        return null;
    }
}

function parsePort(raw: unknown): number | null {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
        const port = Math.trunc(raw);
        return port > 0 ? port : null;
    }

    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed) return null;
        const port = Number(trimmed);
        if (!Number.isFinite(port)) return null;
        const normalized = Math.trunc(port);
        return normalized > 0 ? normalized : null;
    }

    return null;
}

function buildProxyUrlFromNode(node: unknown): string | null {
    if (typeof node === 'string') {
        return normalizeProxyUrl(node);
    }

    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return null;
    }

    const record = node as Record<string, unknown>;
    if (typeof record.url === 'string') {
        return normalizeProxyUrl(record.url);
    }

    const typeRaw = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
    const host = typeof record.server === 'string'
        ? record.server.trim()
        : typeof record.host === 'string'
            ? record.host.trim()
            : '';
    const port = parsePort(record.port);

    if (!host || port === null) {
        return null;
    }

    let scheme: string | null = null;
    if (typeRaw === 'http' || typeRaw === 'https') {
        scheme = typeRaw;
    } else if (typeRaw === 'socks' || typeRaw === 'socks4' || typeRaw === 'socks5' || typeRaw === 'socks5h') {
        scheme = typeRaw === 'socks' ? 'socks5' : typeRaw;
    }

    if (!scheme) {
        return null;
    }

    const username = typeof record.username === 'string'
        ? record.username
        : typeof record.user === 'string'
            ? record.user
            : '';
    const password = typeof record.password === 'string'
        ? record.password
        : typeof record.pass === 'string'
            ? record.pass
            : '';
    const auth = username
        ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
        : '';

    return `${scheme}://${auth}${host}:${port}`;
}

function extractProxyUrlsFromStructuredValue(value: unknown): string[] {
    if (Array.isArray(value)) {
        return dedupeStrings(value.flatMap((entry) => extractProxyUrlsFromStructuredValue(entry)));
    }

    if (!value || typeof value !== 'object') {
        return [];
    }

    const direct = buildProxyUrlFromNode(value);
    const nestedValues = Object.values(value as Record<string, unknown>)
        .filter((entry) => Array.isArray(entry))
        .flatMap((entry) => extractProxyUrlsFromStructuredValue(entry));

    return dedupeStrings([...(direct ? [direct] : []), ...nestedValues]);
}

function shouldTryBase64Decode(payload: string): boolean {
    const compact = payload.replace(/\s+/g, '');
    if (compact.length < 8) {
        return false;
    }

    return /^[A-Za-z0-9+/_=-]+$/.test(compact);
}

function toNormalizedBase64(payload: string): string {
    const compact = payload.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    const remainder = compact.length % 4;
    if (remainder === 0) {
        return compact;
    }

    return compact.padEnd(compact.length + (4 - remainder), '=');
}

function maybeDecodeBase64Payload(payload: string): string {
    if (!shouldTryBase64Decode(payload)) {
        return payload;
    }

    try {
        const decoded = Buffer.from(toNormalizedBase64(payload), 'base64').toString('utf-8');
        if (/(?:https?|socks(?:4|5|5h)?):\/\//i.test(decoded) || /^\s*(?:\{|\[|proxies:|outbounds:)/im.test(decoded)) {
            return decoded;
        }
    } catch {
    }

    return payload;
}

function extractProxyUrlsFromPlainText(payload: string): string[] {
    const matches = payload.match(/(?:https?|socks(?:4|5|5h)?):\/\/[^\s'"<>]+/gi) ?? [];
    return dedupeStrings(matches
        .map((match) => match.replace(/[),.;]+$/g, ''))
        .map((match) => normalizeProxyUrl(match))
        .filter((value): value is string => Boolean(value)));
}

function looksStructuredPayload(payload: string, format: ProxySubscriptionConfig['format']): boolean {
    if (format === 'json' || format === 'clash') {
        return true;
    }

    return /^\s*(?:\{|\[|proxies:|outbounds:)/im.test(payload);
}

export function extractProxyUrlsFromSubscriptionPayload(
    payload: string,
    format: ProxySubscriptionConfig['format'] = 'auto',
): string[] {
    const decodedPayload = format === 'auto' || format === 'url-list'
        ? maybeDecodeBase64Payload(payload.trim())
        : payload.trim();
    if (!decodedPayload) {
        return [];
    }

    if (looksStructuredPayload(decodedPayload, format)) {
        try {
            const parsed = format === 'json'
                ? JSON.parse(decodedPayload)
                : parseYaml(decodedPayload);
            const structuredUrls = extractProxyUrlsFromStructuredValue(parsed);
            if (structuredUrls.length > 0 || format !== 'auto') {
                return structuredUrls;
            }
        } catch {
            if (format !== 'auto') {
                return [];
            }
        }
    }

    return extractProxyUrlsFromPlainText(decodedPayload);
}

export function mergeProxyPools(staticProxyPool: string[], importedProxyPool: string[]): string[] {
    return dedupeStrings([...staticProxyPool, ...importedProxyPool]);
}

export function setRuntimeProxyPool(endpoints: string[]): void {
    const config = getConfig();
    const previousRuntimePool = new Set(runtimeProxyPool);
    runtimeProxyPool = dedupeStrings(endpoints);

    const currentStaticPool = dedupeStrings(config.proxyPool.filter((proxyUrl) => !previousRuntimePool.has(proxyUrl)));
    if (baseProxyPool !== null) {
        baseProxyPool = dedupeStrings(baseProxyPool.filter((proxyUrl) => !previousRuntimePool.has(proxyUrl)));
        applyImportedProxyPool();
        return;
    }

    config.proxyPool = dedupeStrings([...runtimeProxyPool, ...currentStaticPool]);
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
            throw new Error(`Subscription payload exceeded ${maxBytes} bytes`);
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

function syncRuntimeStates(): ProxySubscriptionConfig[] {
    const subscriptions = getConfig().proxySubscriptions;
    const activeIds = new Set<string>();

    for (const subscription of subscriptions) {
        const id = subscriptionId(subscription);
        activeIds.add(id);
        const existing = runtimeStates.get(id);

        if (existing) {
            existing.config = subscription;
            if (!subscription.enabled) {
                existing.status = 'disabled';
                existing.importedProxyUrls = [];
                existing.nextRefreshAt = undefined;
            }
            continue;
        }

        runtimeStates.set(id, {
            id,
            config: subscription,
            status: subscription.enabled ? 'idle' : 'disabled',
            importedProxyUrls: [],
        });
    }

    for (const [id, timer] of refreshTimers.entries()) {
        if (activeIds.has(id)) continue;
        clearInterval(timer);
        refreshTimers.delete(id);
    }

    for (const id of [...runtimeStates.keys()]) {
        if (!activeIds.has(id)) {
            runtimeStates.delete(id);
        }
    }

    return subscriptions;
}

function applyImportedProxyPool(): void {
    const config = getConfig();
    const staticProxyPool = baseProxyPool ?? config.proxyPool;
    const imported = [...runtimeStates.values()]
        .filter((state) => state.config.enabled)
        .flatMap((state) => state.importedProxyUrls);

    config.proxyPool = dedupeStrings([...runtimeProxyPool, ...mergeProxyPools(staticProxyPool, imported)]);
}

async function fetchSubscriptionPayload(subscription: ProxySubscriptionConfig): Promise<string> {
    const config = getConfig();
    const url = validateSubscriptionUrl(subscription.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.proxySubscriptionTimeoutMs);

    try {
        const response = await fetch(url, {
            method: 'GET',
            signal: controller.signal,
            headers: {
                'accept': '*/*',
                'user-agent': config.fingerprint.userAgent,
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        return await readResponseTextWithLimit(response, config.proxySubscriptionMaxBytes);
    } finally {
        clearTimeout(timer);
    }
}

async function refreshSubscription(subscription: ProxySubscriptionConfig, reason: string): Promise<void> {
    const state = runtimeStates.get(subscriptionId(subscription));
    if (!state) return;
    const label = displaySubscriptionName(subscription);

    state.status = 'loading';
    state.lastFetchedAt = Date.now();

    try {
        const payload = await fetchSubscriptionPayload(subscription);
        const importedProxyUrls = extractProxyUrlsFromSubscriptionPayload(payload, subscription.format);
        state.importedProxyUrls = importedProxyUrls;
        state.lastSuccessAt = Date.now();
        state.lastError = undefined;
        state.lastErrorAt = undefined;
        state.status = 'ready';

        console.log(`[ProxySubscription] ${label} ${reason} 导入 ${importedProxyUrls.length} 个可用代理`);
    } catch (error) {
        state.status = 'error';
        state.lastErrorAt = Date.now();
        state.lastError = summarizeError(error);
        console.warn(`[ProxySubscription] ${label} ${reason} 失败: ${state.lastError}`);
    } finally {
        state.nextRefreshAt = Date.now() + subscription.refreshIntervalMs;
    }
}

function resetRefreshTimers(): void {
    for (const timer of refreshTimers.values()) {
        clearInterval(timer);
    }
    refreshTimers.clear();

    for (const subscription of syncRuntimeStates()) {
        if (!subscription.enabled) continue;
        const id = subscriptionId(subscription);
        const state = runtimeStates.get(id);
        if (state) {
            state.nextRefreshAt = Date.now() + subscription.refreshIntervalMs;
        }

        const timer = setInterval(() => {
            void reloadProxySubscriptions(`interval:${displaySubscriptionName(subscription)}`, [id]);
        }, subscription.refreshIntervalMs);

        refreshTimers.set(id, timer);
    }
}

export function getProxySubscriptionSnapshot(): ProxySubscriptionSnapshot {
    syncRuntimeStates();
    const config = getConfig();
    const subscriptions = [...runtimeStates.values()].map((state) => ({
        id: state.id,
        name: displaySubscriptionName(state.config),
        source: maskSubscriptionUrl(state.config.url),
        enabled: state.config.enabled,
        format: state.config.format,
        refreshIntervalMs: state.config.refreshIntervalMs,
        status: state.status,
        importedCount: state.importedProxyUrls.length,
        lastFetchedAt: toIso(state.lastFetchedAt),
        lastSuccessAt: toIso(state.lastSuccessAt),
        lastErrorAt: toIso(state.lastErrorAt),
        lastError: state.lastError ?? null,
        nextRefreshAt: toIso(state.nextRefreshAt),
    }));

    const importedProxyCount = subscriptions.reduce((sum, subscription) => sum + subscription.importedCount, 0);

    return {
        enabled: subscriptions.some((subscription) => subscription.enabled),
        subscriptionCount: subscriptions.length,
        importedProxyCount,
        totalProxyCount: config.proxyPool.length,
        subscriptions,
    };
}

export async function reloadProxySubscriptions(
    reason = 'manual',
    targetIds?: string[],
): Promise<ProxySubscriptionSnapshot> {
    if (reloadPromise) {
        return reloadPromise;
    }

    reloadPromise = (async () => {
        const config = getConfig();
        baseProxyPool ??= dedupeStrings(config.proxyPool);

        const enabledSubscriptions = syncRuntimeStates().filter((subscription) => subscription.enabled);
        const targetIdSet = targetIds && targetIds.length > 0 ? new Set(targetIds) : null;
        const subscriptions = targetIdSet
            ? enabledSubscriptions.filter((subscription) => targetIdSet.has(subscriptionId(subscription)))
            : enabledSubscriptions;
        if (enabledSubscriptions.length === 0) {
            applyImportedProxyPool();
            return getProxySubscriptionSnapshot();
        }

        if (subscriptions.length > 0) {
            await Promise.all(subscriptions.map((subscription) => refreshSubscription(subscription, reason)));
        }
        applyImportedProxyPool();
        return getProxySubscriptionSnapshot();
    })();

    try {
        return await reloadPromise;
    } finally {
        reloadPromise = null;
    }
}

export async function initProxySubscriptions(): Promise<ProxySubscriptionSnapshot> {
    const config = getConfig();
    baseProxyPool ??= dedupeStrings(config.proxyPool.filter((proxyUrl) => !runtimeProxyPool.includes(proxyUrl)));
    syncRuntimeStates();
    resetRefreshTimers();

    if (config.proxySubscriptions.some((subscription) => subscription.enabled)) {
        await reloadProxySubscriptions('startup');
    } else {
        applyImportedProxyPool();
    }

    return getProxySubscriptionSnapshot();
}
