import * as https from 'https';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { CursorChatRequest, CursorSSEEvent } from './types.js';
import { getConfig } from './config.js';
import { getQueue, RequestQueue, RequestAbortedError } from './queue.js';

const CURSOR_CHAT_API_HOST = 'cursor.com';
const CURSOR_CHAT_API_PATH = '/api/chat';

let proxyIndex = 0;

interface ProxyRuntimeState {
    status: 'healthy' | 'paused';
    pausedUntil: number;
    consecutiveFailures: number;
    lastCheckedAt: number;
    lastSuccessAt: number;
    lastFailureAt: number;
    lastReason?: string;
}

const proxyStates = new Map<string, ProxyRuntimeState>();

let directCooldownUntil = 0;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let healthCheckRunning = false;
let lastNoHealthyProxyLogAt = 0;
let lastDirectCooldownLogAt = 0;

function getOrInitProxyState(proxyUrl: string): ProxyRuntimeState {
    const existing = proxyStates.get(proxyUrl);
    if (existing) return existing;

    const next: ProxyRuntimeState = {
        status: 'healthy',
        pausedUntil: 0,
        consecutiveFailures: 0,
        lastCheckedAt: 0,
        lastSuccessAt: 0,
        lastFailureAt: 0,
    };
    proxyStates.set(proxyUrl, next);
    return next;
}

function syncProxyStates(pool: string[]): void {
    const alive = new Set(pool);
    for (const proxyUrl of pool) {
        getOrInitProxyState(proxyUrl);
    }
    for (const proxyUrl of proxyStates.keys()) {
        if (!alive.has(proxyUrl)) {
            proxyStates.delete(proxyUrl);
        }
    }
}

function normalizeDirectCooldownMs(retryAfterMs: number): number {
    const config = getConfig();
    const raw = retryAfterMs > 0 ? retryAfterMs : config.direct429CooldownMs;
    const minApplied = Math.max(raw, config.direct429CooldownMs);
    const cap = Math.max(config.maxRetryDelay, config.direct429CooldownMs);
    return Math.min(minApplied, cap);
}

function getDirectCooldownRemainingMs(now = Date.now()): number {
    return Math.max(0, directCooldownUntil - now);
}

function logDirectCooldownRouting(remainingMs: number): void {
    const now = Date.now();
    if (now - lastDirectCooldownLogAt < 5_000) return;
    lastDirectCooldownLogAt = now;
    console.warn(`[Cursor] 直连冷却中（剩余 ${Math.ceil(remainingMs / 1000)}s），优先切换代理`);
}

function markDirectRateLimited(retryAfterMs: number): number {
    const now = Date.now();
    const cooldownMs = normalizeDirectCooldownMs(retryAfterMs);
    const nextUntil = now + cooldownMs;
    if (nextUntil > directCooldownUntil) {
        directCooldownUntil = nextUntil;
    }
    const remaining = getDirectCooldownRemainingMs(now);
    console.warn(`[Cursor] 直连触发 429，暂停直连 ${Math.ceil(remaining / 1000)}s，期间改走代理`);
    return remaining;
}

function computeProxyPauseMs(consecutiveFailures: number): number {
    const config = getConfig();
    const exp = Math.max(0, Math.min(consecutiveFailures - 1, 6));
    const raw = Math.min(config.proxyPauseBaseMs * Math.pow(2, exp), config.proxyPauseMaxMs);
    const jitter = raw * 0.2 * (Math.random() * 2 - 1);
    const value = raw + jitter;
    return Math.round(Math.max(config.proxyPauseBaseMs, Math.min(config.proxyPauseMaxMs, value)));
}

function markProxyPaused(proxyUrl: string, reason: string, explicitPauseMs?: number): void {
    const state = getOrInitProxyState(proxyUrl);
    const now = Date.now();
    state.consecutiveFailures += 1;
    state.lastFailureAt = now;
    state.lastReason = reason;
    state.status = 'paused';

    const pauseMs = explicitPauseMs && explicitPauseMs > 0
        ? Math.min(explicitPauseMs, getConfig().proxyPauseMaxMs)
        : computeProxyPauseMs(state.consecutiveFailures);
    const nextPausedUntil = now + pauseMs;
    if (nextPausedUntil > state.pausedUntil) {
        state.pausedUntil = nextPausedUntil;
    }

    const remaining = Math.max(0, state.pausedUntil - now);
    console.warn(`[Cursor] 代理暂停 ${Math.ceil(remaining / 1000)}s: ${proxyUrl} (${reason})`);
}

function markProxyHealthy(proxyUrl: string, reason: string, observedAt = Date.now()): void {
    const state = getOrInitProxyState(proxyUrl);
    const now = Date.now();

    if (state.lastFailureAt > observedAt) {
        return;
    }

    const wasPaused = state.status === 'paused' || state.pausedUntil > now;

    state.status = 'healthy';
    state.pausedUntil = 0;
    state.consecutiveFailures = 0;
    state.lastSuccessAt = now;
    state.lastReason = undefined;

    if (wasPaused) {
        console.log(`[Cursor] 代理恢复可用: ${proxyUrl} (${reason})`);
    }
}

function isProxyAvailable(proxyUrl: string, now = Date.now()): boolean {
    const state = getOrInitProxyState(proxyUrl);
    return state.pausedUntil <= now;
}

function nextProxyUrl(excluded = new Set<string>()): string | null {
    const pool = getConfig().proxyPool;
    if (!pool || pool.length === 0) return null;

    syncProxyStates(pool);
    const now = Date.now();

    for (let i = 0; i < pool.length; i++) {
        const url = pool[proxyIndex % pool.length];
        proxyIndex++;
        if (excluded.has(url)) {
            continue;
        }
        if (isProxyAvailable(url, now)) {
            return url;
        }
    }

    if (now - lastNoHealthyProxyLogAt > 5_000) {
        lastNoHealthyProxyLogAt = now;
        console.warn('[Cursor] 当前无可用代理（均处于暂停状态）');
    }
    return null;
}

function isConnectionError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message;
    return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|socket hang up|Proxy connection timed out|proxy connection timed out/i.test(msg);
}

function isProxyBlockedError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message;
    return /HTTP 403|Vercel Security Checkpoint|Security Checkpoint/i.test(msg);
}

const agentCache = new Map<string, https.Agent>();

function makeAgent(proxyUrl: string | null): https.Agent | undefined {
    if (!proxyUrl) return undefined;
    const cached = agentCache.get(proxyUrl);
    if (cached) return cached;
    const agent = proxyUrl.startsWith('socks')
        ? new SocksProxyAgent(proxyUrl, { keepAlive: true })
        : new HttpsProxyAgent(proxyUrl, { keepAlive: true });
    agentCache.set(proxyUrl, agent);
    return agent;
}

function deriveChromeFingerprintHeaders(ua: string): Record<string, string> {
    const chromeMatch = ua.match(/Chrome\/(\d+)\./);
    const chromeVersion = chromeMatch ? chromeMatch[1] : '140';

    const isMac = /Macintosh|Mac OS X/i.test(ua);
    const isLinux = /Linux/i.test(ua) && !/Android/i.test(ua);
    const isWindows = /Windows/i.test(ua);
    const isMobile = /Mobile|Android/i.test(ua);
    const isArm = /arm|aarch64/i.test(ua);

    const platform = isMac ? 'macOS' : isLinux ? 'Linux' : 'Windows';
    const arch = isArm ? 'arm' : 'x86';
    const bitness = isMobile ? '32' : '64';
    const mobile = isMobile ? '?1' : '?0';

    const notBrandVersion = ((parseInt(chromeVersion) % 3) + 22).toString();
    const secChUa = `"Chromium";v="${chromeVersion}", "Not=A?Brand";v="${notBrandVersion}", "Google Chrome";v="${chromeVersion}"` ;

    const platformVersion = isWindows ? '19.0.0' : isMac ? '14.5.0' : '6.6.0';

    return {
        'sec-ch-ua-platform': `"${platform}"`,
        'sec-ch-ua': secChUa,
        'sec-ch-ua-bitness': `"${bitness}"`,
        'sec-ch-ua-mobile': mobile,
        'sec-ch-ua-arch': `"${arch}"`,
        'sec-ch-ua-platform-version': `"${platformVersion}"`,
    };
}

function getChromeHeaders(): Record<string, string> {
    const config = getConfig();
    const ua = config.fingerprint.userAgent;
    const derived = deriveChromeFingerprintHeaders(ua);
    return {
        'Content-Type': 'application/json',
        'x-path': '/api/chat',
        'x-method': 'POST',
        ...derived,
        'origin': 'https://cursor.com',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'referer': 'https://cursor.com/',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'priority': 'u=1, i',
        'user-agent': ua,
        'x-is-human': '',
    };
}

class RateLimitError extends Error {
    retryAfterMs: number;
    constructor(retryAfterMs: number) {
        const hint = retryAfterMs > 0 ? `，建议等待 ${retryAfterMs}ms` : '';
        super(`Cursor API 429 限流${hint}`);
        this.retryAfterMs = retryAfterMs;
    }
}

export function isAbortError(err: unknown): boolean {
    return err instanceof RequestAbortedError;
}

function parseRetryAfterMs(value: string | string[] | undefined): number {
    if (!value) return 0;
    const raw = Array.isArray(value) ? value[0] : value;
    const trimmed = raw.trim();
    if (!trimmed) return 0;
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds)) {
        return Math.max(0, Math.round(seconds * 1000));
    }
    const dateMs = Date.parse(trimmed);
    if (!Number.isNaN(dateMs)) {
        const delta = dateMs - Date.now();
        return delta > 0 ? delta : 0;
    }
    return 0;
}

function summarizeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function isHealthyProbeStatus(statusCode: number, locationHeader: string | string[] | undefined): boolean {
    if (statusCode >= 200 && statusCode < 300) {
        return true;
    }

    if (statusCode >= 300 && statusCode < 400) {
        const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
        if (!location) return false;
        if (location.startsWith('/')) {
            return true;
        }
        try {
            const target = new URL(location);
            return target.hostname === CURSOR_CHAT_API_HOST;
        } catch {
            return false;
        }
    }

    return false;
}

function pauseProxyFromRequestError(proxyUrl: string, err: unknown): void {
    if (err instanceof RateLimitError) {
        const pauseMs = normalizeDirectCooldownMs(err.retryAfterMs);
        markProxyPaused(proxyUrl, 'HTTP 429', pauseMs);
        return;
    }

    if (isProxyBlockedError(err)) {
        markProxyPaused(proxyUrl, 'Security Checkpoint');
        return;
    }

    if (isConnectionError(err)) {
        markProxyPaused(proxyUrl, '连接错误');
        return;
    }

    markProxyPaused(proxyUrl, '请求失败');
}

async function probeProxy(proxyUrl: string): Promise<{ ok: boolean; reason?: string }> {
    const config = getConfig();
    const agent = makeAgent(proxyUrl);

    return new Promise((resolve) => {
        let settled = false;
        const done = (ok: boolean, reason?: string) => {
            if (settled) return;
            settled = true;
            resolve({ ok, reason });
        };

        const requestOptions: https.RequestOptions = {
            hostname: CURSOR_CHAT_API_HOST,
            path: '/',
            method: 'GET',
            headers: {
                'user-agent': config.fingerprint.userAgent,
                'accept': '*/*',
            },
            ...(agent ? { agent } : {}),
        };

        const reqHttp = https.request(requestOptions, (res) => {
            const statusCode = res.statusCode ?? 0;
            res.resume();

            if (isHealthyProbeStatus(statusCode, res.headers.location)) {
                done(true);
                return;
            }
            done(false, `HTTP ${statusCode}`);
        });

        reqHttp.setTimeout(config.proxyProbeTimeoutMs, () => {
            done(false, `timeout ${config.proxyProbeTimeoutMs}ms`);
            reqHttp.destroy();
        });

        reqHttp.on('error', (err) => {
            done(false, summarizeError(err));
        });

        reqHttp.end();
    });
}

async function runProxyHealthChecks(): Promise<void> {
    if (healthCheckRunning) return;
    healthCheckRunning = true;

    try {
        const pool = getConfig().proxyPool;
        if (!pool.length) return;

        syncProxyStates(pool);
        const now = Date.now();

        await Promise.all(pool.map(async (proxyUrl) => {
            const state = getOrInitProxyState(proxyUrl);
            if (state.pausedUntil > now) {
                return;
            }

            const probeStartedAt = Date.now();
            const result = await probeProxy(proxyUrl);
            state.lastCheckedAt = Date.now();

            if (result.ok) {
                markProxyHealthy(proxyUrl, 'health-check', probeStartedAt);
                return;
            }

            markProxyPaused(proxyUrl, `health-check:${result.reason ?? 'unreachable'}`);
        }));
    } catch (err) {
        console.warn(`[Cursor] 代理健康检查异常: ${summarizeError(err)}`);
    } finally {
        healthCheckRunning = false;
    }
}

function ensureProxyHealthChecker(): void {
    const pool = getConfig().proxyPool;
    if (!pool.length) {
        if (healthCheckTimer) {
            clearInterval(healthCheckTimer);
            healthCheckTimer = null;
        }
        return;
    }

    syncProxyStates(pool);

    if (healthCheckTimer) return;

    const intervalMs = Math.max(5_000, getConfig().proxyHealthCheckIntervalMs);
    healthCheckTimer = setInterval(() => {
        void runProxyHealthChecks();
    }, intervalMs);

    if (typeof healthCheckTimer.unref === 'function') {
        healthCheckTimer.unref();
    }

    console.log(`[Cursor] 启动代理健康检查，间隔 ${Math.round(intervalMs / 1000)}s`);
    void runProxyHealthChecks();
}

export async function sendCursorRequest(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    signal?: AbortSignal,
): Promise<void> {
    const MAX_429_RETRIES = 12;
    const queue = getQueue();
    const config = getConfig();
    if (config.proxyPool.length > 0) {
        ensureProxyHealthChecker();
    }
    let attempt429 = 0;

    while (true) {
        if (signal?.aborted) {
            throw new RequestAbortedError();
        }
        try {
            await queue.enqueue(() => sendCursorRequestWithProxyRetries(req, onChunk, signal), { signal });
            return;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const is429 = err instanceof RateLimitError
                || /HTTP\s*429/i.test(msg)
                || /rate\s*limit/i.test(msg)
                || /too\s+many\s+requests/i.test(msg);

            if (!is429) {
                throw err;
            }

            attempt429++;
            if (attempt429 > MAX_429_RETRIES) {
                throw new Error(`Cursor API 429 重试达到上限 (${MAX_429_RETRIES})`);
            }
            const retryAfterMs = err instanceof RateLimitError ? err.retryAfterMs : 0;
            const cappedRetryAfterMs = retryAfterMs > 0 ? Math.min(retryAfterMs, config.maxRetryDelay) : 0;
            const backoffDelay = RequestQueue.computeRetryDelay(attempt429, config.retryDelay, config.maxRetryDelay);
            const delay = Math.max(backoffDelay, cappedRetryAfterMs);
            const retryHint = cappedRetryAfterMs > 0 ? `, Retry-After=${cappedRetryAfterMs}ms` : '';
            console.warn(`[Cursor] 429 限流 (第${attempt429}次)，${delay}ms 后继续排队重试...${retryHint} (队列 运行中=${queue.activeCount}, 等待=${queue.pendingCount})`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
}

async function sendCursorRequestWithProxyRetries(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    signal?: AbortSignal,
): Promise<void> {
    const pool = getConfig().proxyPool;
    if (pool.length > 0) {
        ensureProxyHealthChecker();
    }

    let lastError: unknown;
    let sawRateLimit = false;
    let maxRetryAfterMs = 0;

    const tryProxyPool = async (): Promise<boolean> => {
        if (pool.length === 0) return false;

        const attemptedProxies = new Set<string>();
        const maxRetries = Math.max(1, pool.length);
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            if (signal?.aborted) {
                throw new RequestAbortedError();
            }

            const proxyUrl = nextProxyUrl(attemptedProxies);
            if (!proxyUrl) break;
            attemptedProxies.add(proxyUrl);

            try {
                await sendCursorRequestInner(req, onChunk, makeAgent(proxyUrl), proxyUrl, signal);
                markProxyHealthy(proxyUrl, 'request-success');
                return true;
            } catch (err) {
                lastError = err;

                if (err instanceof RequestAbortedError) {
                    throw err;
                }

                if (err instanceof RateLimitError) {
                    sawRateLimit = true;
                    maxRetryAfterMs = Math.max(maxRetryAfterMs, normalizeDirectCooldownMs(err.retryAfterMs));
                }

                pauseProxyFromRequestError(proxyUrl, err);
                console.error(`[Cursor] 代理请求失败 (${attempt}/${maxRetries}) [${proxyUrl}]: ${summarizeError(err)}`);

                if (attempt < maxRetries) {
                    await new Promise(r => setTimeout(r, 500));
                }
            }
        }

        return false;
    };

    const directCooldownRemaining = getDirectCooldownRemainingMs();
    if (directCooldownRemaining === 0) {
        try {
            await sendCursorRequestInner(req, onChunk, undefined, null, signal);
            return;
        } catch (err) {
            lastError = err;

            if (err instanceof RequestAbortedError) {
                throw err;
            }

            if (err instanceof RateLimitError) {
                sawRateLimit = true;
                const remaining = markDirectRateLimited(err.retryAfterMs);
                maxRetryAfterMs = Math.max(maxRetryAfterMs, remaining);

                const proxied = await tryProxyPool();
                if (proxied) return;

                throw new RateLimitError(Math.max(maxRetryAfterMs, getDirectCooldownRemainingMs()));
            }

            if (pool.length > 0) {
                console.warn(`[Cursor] 直连请求失败，尝试代理兜底: ${summarizeError(err)}`);
                const proxied = await tryProxyPool();
                if (proxied) return;
            }

            throw err;
        }
    }

    logDirectCooldownRouting(directCooldownRemaining);
    const proxied = await tryProxyPool();
    if (proxied) return;

    const remainingAfterProxy = getDirectCooldownRemainingMs();
    if (remainingAfterProxy === 0) {
        try {
            await sendCursorRequestInner(req, onChunk, undefined, null, signal);
            return;
        } catch (err) {
            lastError = err;

            if (err instanceof RequestAbortedError) {
                throw err;
            }

            if (err instanceof RateLimitError) {
                sawRateLimit = true;
                const remaining = markDirectRateLimited(err.retryAfterMs);
                maxRetryAfterMs = Math.max(maxRetryAfterMs, remaining);
            } else {
                throw err;
            }
        }
    }

    const directCooldownRemainingNow = getDirectCooldownRemainingMs();

    if (sawRateLimit || directCooldownRemainingNow > 0) {
        throw new RateLimitError(Math.max(maxRetryAfterMs, directCooldownRemainingNow));
    }

    if (lastError) {
        throw lastError;
    }

    throw new Error('No available upstream route: direct cooling down and no healthy proxy');
}

async function sendCursorRequestInner(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    agent: https.Agent | undefined,
    proxyUrl: string | null,
    signal?: AbortSignal,
): Promise<void> {
    const headers = getChromeHeaders();
    const body = JSON.stringify(req);
    const config = getConfig();
    const timeoutSeconds = Number.isFinite(config.timeout) ? config.timeout : 120;
    const idleTimeoutMs = Math.max(1_000, Math.round(timeoutSeconds * 1000));
    const connectTimeoutMs = Math.max(2_000, idleTimeoutMs * 2);

    console.log(`[Cursor] 发送请求: model=${req.model}, messages=${req.messages.length}${proxyUrl ? ` [proxy=${proxyUrl}]` : ''}`);

    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new RequestAbortedError());
            return;
        }

        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        let connectTimer: ReturnType<typeof setTimeout> | null = null;
        let settled = false;
        let abortHandler: (() => void) | null = null;

        const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
        const clearConnect = () => { if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; } };

        const cleanup = () => {
            clearIdle();
            clearConnect();
            if (signal && abortHandler) {
                signal.removeEventListener('abort', abortHandler);
                abortHandler = null;
            }
        };

        const settleResolve = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
        };

        const settleReject = (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };

        const options: https.RequestOptions = {
            hostname: CURSOR_CHAT_API_HOST,
            path: CURSOR_CHAT_API_PATH,
            method: 'POST',
            headers: {
                ...headers,
                'Content-Length': Buffer.byteLength(body),
            },
            ...(agent ? { agent } : {}),
        };

        const reqHttp = https.request(options, (res) => {
            if (settled) {
                res.resume();
                return;
            }

            clearConnect();

            if (res.statusCode === 429) {
                clearIdle();
                const waitMs = parseRetryAfterMs(res.headers['retry-after']);
                res.resume();
                settleReject(new RateLimitError(waitMs));
                return;
            }

            if (!res.statusCode || res.statusCode >= 300) {
                clearIdle();
                let errBody = '';
                res.on('data', (chunk: Buffer) => {
                    if (settled) return;
                    errBody += chunk.toString();
                });
                res.on('end', () => {
                    if (settled) return;
                    settleReject(new Error(`Cursor API 错误: HTTP ${res.statusCode} - ${errBody}`));
                });
                res.on('error', (err) => {
                    settleReject(err);
                });
                return;
            }

            const resetIdleTimer = () => {
                clearIdle();
                idleTimer = setTimeout(() => {
                    const timeoutError = new Error('Cursor API 空闲超时');
                    console.warn(`[Cursor] 空闲超时（${Math.round(idleTimeoutMs / 1000)}s 无新数据），中止请求`);
                    if (!reqHttp.destroyed) {
                        reqHttp.destroy(timeoutError);
                    }
                    settleReject(timeoutError);
                }, idleTimeoutMs);
            };

            clearIdle();
            let buffer = '';
            res.on('data', (chunk: Buffer) => {
                if (settled) return;
                resetIdleTimer();
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';
                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (!data) continue;
                    try {
                        const event: CursorSSEEvent = JSON.parse(data);
                        onChunk(event);
                    } catch { }
                }
            });

            res.on('end', () => {
                if (settled) return;

                if (buffer.startsWith('data: ')) {
                    const data = buffer.slice(6).trim();
                    if (data) {
                        try { onChunk(JSON.parse(data) as CursorSSEEvent); } catch { }
                    }
                }
                settleResolve();
            });

            res.on('error', (err) => {
                settleReject(err);
            });

            resetIdleTimer();
        });

        connectTimer = setTimeout(() => {
            const timeoutError = new Error('Cursor API 连接超时');
            console.warn(`[Cursor] 连接超时（${Math.round(connectTimeoutMs / 1000)}s 未收到响应头），中止请求`);
            if (!reqHttp.destroyed) {
                reqHttp.destroy(timeoutError);
            }
            settleReject(timeoutError);
        }, connectTimeoutMs);

        if (signal) {
            abortHandler = () => {
                const abortError = new RequestAbortedError();
                if (!reqHttp.destroyed) {
                    reqHttp.destroy(abortError);
                }
                settleReject(abortError);
            };
            if (signal.aborted) {
                abortHandler();
                return;
            }
            signal.addEventListener('abort', abortHandler, { once: true });
        }

        reqHttp.on('error', (err) => {
            settleReject(err);
        });

        reqHttp.write(body);
        reqHttp.end();
    });
}

export async function sendCursorRequestFull(req: CursorChatRequest, signal?: AbortSignal): Promise<string> {
    const { fullText } = await sendCursorRequestFullWithUsage(req, signal);
    return fullText;
}

export async function sendCursorRequestFullWithUsage(
    req: CursorChatRequest,
    signal?: AbortSignal,
): Promise<{
    fullText: string;
    usage?: CursorSSEEvent['usage'];
}> {
    let fullText = '';
    let usage: CursorSSEEvent['usage'] | undefined;
    await sendCursorRequest(req, (event) => {
        if (event.type === 'text-delta' && event.delta) {
            fullText += event.delta;
        }
        if (event.usage) usage = event.usage;
    }, signal);
    return { fullText, usage };
}
