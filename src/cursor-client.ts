import * as https from 'https';
import * as http from 'http';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { CursorChatRequest, CursorSSEEvent } from './types.js';
import { getConfig } from './config.js';

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
    return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|socket hang up/i.test(msg);
}

function makeAgent(proxyUrl: string | null): https.Agent | undefined {
    if (!proxyUrl) return undefined;
    if (proxyUrl.startsWith('socks')) {
        return new SocksProxyAgent(proxyUrl);
    }
    return new HttpsProxyAgent(proxyUrl);
}

function getChromeHeaders(): Record<string, string> {
    const config = getConfig();
    return {
        'Content-Type': 'application/json',
        'sec-ch-ua-platform': '"Windows"',
        'x-path': '/api/chat',
        'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
        'x-method': 'POST',
        'sec-ch-ua-bitness': '"64"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-arch': '"x86"',
        'sec-ch-ua-platform-version': '"19.0.0"',
        'origin': 'https://cursor.com',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'referer': 'https://cursor.com/',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'priority': 'u=1, i',
        'user-agent': config.fingerprint.userAgent,
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
                if (attempt >= maxRetries) throw err;
                const waitMs = err.retryAfterMs || Math.min(5000 * Math.pow(2, attempt - 1), 60000);
                console.warn(`[Cursor] 429 限流 (${attempt}/${maxRetries})，等待 ${waitMs}ms，切换代理...`);
                await new Promise(r => setTimeout(r, waitMs));
                continue;
            }

            // 代理连接失败，标记为死亡
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

    // 所有重试用尽后，若最后一次用了代理，尝试一次直连兜底
    const pool = getConfig().proxyPool;
    if (pool && pool.length > 0) {
        console.warn('[Cursor] 所有代理重试失败，最终尝试直连...');
        try {
            await sendCursorRequestInner(req, onChunk, undefined, null);
            return;
        } catch (directErr) {
            const msg = directErr instanceof Error ? directErr.message : String(directErr);
            console.error(`[Cursor] 直连也失败: ${msg}`);
            // 抛出直连的错误（更有参考价值）
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
        const resetIdleTimer = () => {
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                console.warn(`[Cursor] 空闲超时（${config.timeout}s 无新数据），中止请求`);
                reject(new Error('Cursor API 空闲超时'));
            }, IDLE_TIMEOUT_MS);
        };
        const clearIdleTimer = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
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
                clearIdleTimer();
                const retryAfter = res.headers['retry-after'];
                const waitMs = retryAfter ? parseInt(String(retryAfter)) * 1000 : 0;
                res.resume();
                reject(new RateLimitError(waitMs));
                return;
            }

            if (!res.statusCode || res.statusCode >= 300) {
                clearIdleTimer();
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
                clearIdleTimer();
                if (buffer.startsWith('data: ')) {
                    const data = buffer.slice(6).trim();
                    if (data) {
                        try { onChunk(JSON.parse(data) as CursorSSEEvent); } catch { }
                    }
                }
                resolve();
            });

            res.on('error', (err) => {
                clearIdleTimer();
                reject(err);
            });
        });

        reqHttp.on('error', (err) => {
            clearIdleTimer();
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
