import * as https from 'https';
import * as http from 'http';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { CursorChatRequest, CursorSSEEvent } from './types.js';
import { getConfig } from './config.js';
import { getQueue, RequestQueue } from './queue.js';

const CURSOR_CHAT_API_HOST = 'cursor.com';
const CURSOR_CHAT_API_PATH = '/api/chat';

let proxyIndex = 0;

/** 记录最近连接失败的代理（ECONNREFUSED 等网络错误），value = 失败时间戳 */
const deadProxies = new Map<string, number>();
/** 代理被标记为死亡后的冷却时间（ms），过后重新尝试 */
const DEAD_PROXY_COOLDOWN = 60_000;

function nextProxyUrl(): string | null {
    const pool = getConfig().proxyPool;
    if (!pool || pool.length === 0) return null;

    const now = Date.now();
    // 尝试找到一个存活的代理，最多检查 pool.length 次
    for (let i = 0; i < pool.length; i++) {
        const url = pool[proxyIndex % pool.length];
        proxyIndex++;
        const deadAt = deadProxies.get(url);
        if (!deadAt || now - deadAt > DEAD_PROXY_COOLDOWN) {
            deadProxies.delete(url);
            return url;
        }
    }
    // 所有代理都在冷却期内，回退直连
    console.warn('[Cursor] 所有代理均不可用，回退直连');
    return null;
}

function markProxyDead(proxyUrl: string): void {
    deadProxies.set(proxyUrl, Date.now());
    console.warn(`[Cursor] 代理标记为不可用 (${DEAD_PROXY_COOLDOWN / 1000}s 冷却): ${proxyUrl}`);
}

function isConnectionError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message;
    return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|socket hang up|Proxy connection timed out|proxy connection timed out/i.test(msg);
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
        super(`Cursor API 429 限流，等待 ${retryAfterMs}ms 后重试`);
        this.retryAfterMs = retryAfterMs;
    }
}

export async function sendCursorRequest(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
): Promise<void> {
    const queue = getQueue();
    const config = getConfig();
    const MAX_429_RETRIES = 4;

    for (let attempt429 = 1; attempt429 <= MAX_429_RETRIES; attempt429++) {
        try {
            await queue.enqueue(() => sendCursorRequestWithProxyRetries(req, onChunk));
            return;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const is429 = err instanceof RateLimitError || msg.includes('429') || msg.toLowerCase().includes('rate limit') || msg.toLowerCase().includes('too many');

            if (is429 && attempt429 < MAX_429_RETRIES) {
                const delay = RequestQueue.computeRetryDelay(attempt429, config.retryDelay, config.maxRetryDelay);
                console.warn(`[Cursor] 429 限流 (第${attempt429}次)，${delay}ms 后重试... (队列 运行中=${queue.activeCount}, 等待=${queue.pendingCount})`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }

            if (is429) {
                console.error(`[Cursor] 429 限流重试 ${MAX_429_RETRIES} 次后仍失败`);
            }
            throw err;
        }
    }
}

async function sendCursorRequestWithProxyRetries(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
): Promise<void> {
    const maxRetries = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const proxyUrl = nextProxyUrl();
        const agent = makeAgent(proxyUrl);
        try {
            await sendCursorRequestInner(req, onChunk, agent, proxyUrl);
            return;
        } catch (err) {
            lastError = err;

            if (err instanceof RateLimitError) {
                throw err;
            }

            if (proxyUrl && isConnectionError(err)) {
                markProxyDead(proxyUrl);
            }

            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[Cursor] 请求失败 (${attempt}/${maxRetries}): ${msg}`);
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    }

    const pool = getConfig().proxyPool;
    if (pool && pool.length > 0) {
        console.warn('[Cursor] 所有代理重试失败，最终尝试直连...');
        try {
            await sendCursorRequestInner(req, onChunk, undefined, null);
            return;
        } catch (directErr) {
            const msg = directErr instanceof Error ? directErr.message : String(directErr);
            console.error(`[Cursor] 直连也失败: ${msg}`);
            throw directErr;
        }
    }

    throw lastError;
}

async function sendCursorRequestInner(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
    agent: https.Agent | undefined,
    proxyUrl: string | null,
): Promise<void> {
    const headers = getChromeHeaders();
    const body = JSON.stringify(req);
    const config = getConfig();

    // ★ 空闲超时（Idle Timeout）：用读取活动检测替换固定总时长超时。
    // 每次收到新数据时重置计时器，只有在指定时间内完全无数据到达时才中断。
    // 这样长输出（如写长文章、大量工具调用）不会因总时长超限被误杀。
    const IDLE_TIMEOUT_MS = config.timeout * 1000;

    console.log(`[Cursor] 发送请求: model=${req.model}, messages=${req.messages.length}${proxyUrl ? ` [proxy=${proxyUrl}]` : ''}`);

    return new Promise<void>((resolve, reject) => {
        let idleTimer: ReturnType<typeof setTimeout> | null = null;

        const clearIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
        const resetIdleTimer = () => {
            clearIdle();
            idleTimer = setTimeout(() => {
                console.warn(`[Cursor] 空闲超时（${config.timeout}s 无新数据），中止请求`);
                reject(new Error('Cursor API 空闲超时'));
            }, config.timeout * 1000);
        };

        resetIdleTimer();

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
            if (res.statusCode === 429) {

                clearIdle();

                const retryAfter = res.headers['retry-after'];
                const waitMs = retryAfter ? parseInt(String(retryAfter)) * 1000 : 0;
                res.resume();
                reject(new RateLimitError(waitMs));
                return;
            }

            if (!res.statusCode || res.statusCode >= 300) {

                clearIdle();

                let errBody = '';
                res.on('data', (chunk: Buffer) => { errBody += chunk.toString(); });
                res.on('end', () => reject(new Error(`Cursor API 错误: HTTP ${res.statusCode} - ${errBody}`)));
                return;
            }

            let buffer = '';
            res.on('data', (chunk: Buffer) => {
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

                clearIdle();

                if (buffer.startsWith('data: ')) {
                    const data = buffer.slice(6).trim();
                    if (data) {
                        try { onChunk(JSON.parse(data) as CursorSSEEvent); } catch { }
                    }
                }
                resolve();
            });

            res.on('error', (err) => {

                clearIdle();

                reject(err);
            });
        });

        reqHttp.on('error', (err) => {

            clearIdle();

            reject(err);
        });


        reqHttp.write(body);
        reqHttp.end();
    });
}

export async function sendCursorRequestFull(req: CursorChatRequest): Promise<string> {
    let fullText = '';
    await sendCursorRequest(req, (event) => {
        if (event.type === 'text-delta' && event.delta) {
            fullText += event.delta;
        }
    });
    return fullText;
}
