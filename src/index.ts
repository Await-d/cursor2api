/**
 * Cursor2API v2 - 入口
 *
 * 将 Cursor 文档页免费 AI 接口代理为 Anthropic Messages API
 * 通过提示词注入让 Claude Code 拥有完整工具调用能力
 */
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
initWebLogger();
import { createRequire } from 'module';
import { existsSync } from 'fs';
import express, { type Request, type Response } from 'express';
import { getAirportRuntimeSnapshot, initAirportRuntime } from './airport-runtime.js';
import { getConfig } from './config.js';
import { getProxySubscriptionSnapshot, initProxySubscriptions, reloadProxySubscriptions } from './proxy-subscriptions.js';
import { formatQueueRuntimeStatus, getQueue, initQueue } from './queue.js';
import { handleMessages, listModels, countTokens } from './handler.js';
import { handleOpenAIChatCompletions, handleOpenAIResponses } from './openai-handler.js';
import { initWebLogger, getRecentLogs, registerSseClient } from './web-logger.js';
import { handleGetConfig, handlePostConfig, handleGetRunningConfig } from './admin-config.js';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// 统一日志时间戳
(() => {
    const ts = () => new Date().toISOString().replace('T', ' ').replace('Z', '');
    const wrap = (fn: (...a: unknown[]) => void) =>
        (...args: unknown[]) => fn(`[${ts()}]`, ...args);
    console.log = wrap(console.log.bind(console));
    console.info = wrap(console.info.bind(console));
    console.warn = wrap(console.warn.bind(console));
    console.error = wrap(console.error.bind(console));
})();

// 从 package.json 读取版本号，统一来源，避免多处硬编码
const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json') as { version: string };


const app = express();
const config = getConfig();

await initAirportRuntime();
await initProxySubscriptions();

function isLoopbackAddress(ip?: string): boolean {
    if (!ip) return false;
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function hasForwardedClientAddress(req: Request): boolean {
    return Boolean(req.header('x-forwarded-for')?.trim() || req.header('x-real-ip')?.trim());
}

function ensureInternalOpsAccess(req: Request, res: Response): boolean {
    const localOnlyRequest = isLoopbackAddress(req.ip) && !hasForwardedClientAddress(req);
    if (!config.proxySubscriptionApiEnabled && !localOnlyRequest) {
        res.status(403).json({ error: 'Internal ops API is disabled for remote access' });
        return false;
    }

    if (config.proxySubscriptionApiToken) {
        const token = req.header('x-proxy-subscription-token');
        if (token !== config.proxySubscriptionApiToken) {
            res.status(401).json({ error: 'Invalid proxy subscription API token' });
            return false;
        }
    }

    return true;
}

initQueue({
    concurrency: config.concurrency,
    queueTimeout: config.queueTimeout,
    retryDelay: config.retryDelay,
    maxRetryDelay: config.maxRetryDelay,
});

if (config.queueStatusLogIntervalMs > 0) {
    console.log(`[Queue] 已开启周期状态日志: 间隔=${config.queueStatusLogIntervalMs}ms, ${formatQueueRuntimeStatus(getQueue())}`);
    const queueStatusTimer = setInterval(() => {
        console.log(`[Queue] 周期状态: ${formatQueueRuntimeStatus(getQueue())}`);
    }, config.queueStatusLogIntervalMs);
    if (typeof queueStatusTimer.unref === 'function') {
        queueStatusTimer.unref();
    }
} else {
    console.log('[Queue] 周期状态日志已关闭 (QUEUE_STATUS_LOG_INTERVAL_MS <= 0)');
}

// 解析 JSON body（增大限制以支持 base64 图片，单张图片可达 10MB+）
app.use(express.json({ limit: '50mb' }));

// CORS
app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', '*');
    if (_req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
    }
    next();
});

// ==================== 路由 ====================

// Anthropic Messages API
app.post('/v1/messages', handleMessages);
app.post('/messages', handleMessages);

// OpenAI Chat Completions API（兼容）
app.post('/v1/chat/completions', handleOpenAIChatCompletions);
app.post('/chat/completions', handleOpenAIChatCompletions);

// OpenAI Responses API（Cursor IDE Agent 模式）
app.post('/v1/responses', handleOpenAIResponses);
app.post('/responses', handleOpenAIResponses);

// Token 计数
app.post('/v1/messages/count_tokens', countTokens);
app.post('/messages/count_tokens', countTokens);

// OpenAI 兼容模型列表
app.get('/v1/models', listModels);

app.get('/v1/proxy/subscriptions', (_req, res) => {
    if (!ensureInternalOpsAccess(_req, res)) return;
    res.json(getProxySubscriptionSnapshot());
});

app.get('/proxy/subscriptions', (_req, res) => {
    if (!ensureInternalOpsAccess(_req, res)) return;
    res.json(getProxySubscriptionSnapshot());
});

app.post('/v1/proxy/subscriptions/reload', async (_req, res) => {
    if (!ensureInternalOpsAccess(_req, res)) return;
    try {
        const snapshot = await reloadProxySubscriptions('manual');
        res.json(snapshot);
    } catch (error) {
        res.status(500).json({
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

app.post('/proxy/subscriptions/reload', async (_req, res) => {
    if (!ensureInternalOpsAccess(_req, res)) return;
    try {
        const snapshot = await reloadProxySubscriptions('manual');
        res.json(snapshot);
    } catch (error) {
        res.status(500).json({
            error: error instanceof Error ? error.message : String(error),
        });
    }
});

app.get('/v1/airport/runtime', (_req, res) => {
    if (!ensureInternalOpsAccess(_req, res)) return;
    res.json(getAirportRuntimeSnapshot());
});

app.get('/airport/runtime', (_req, res) => {
    if (!ensureInternalOpsAccess(_req, res)) return;
    res.json(getAirportRuntimeSnapshot());
});



function resolveAdminPublicDir(): string {
    const candidates = [
        join(__dirname, 'public'),
        join(__dirname, '../src/public'),
    ];

    for (const candidate of candidates) {
        if (existsSync(join(candidate, 'index.html'))) {
            return candidate;
        }
    }

    return candidates[0];
}

const publicDir = resolveAdminPublicDir();
app.get('/admin/logs', (_req, res) => { registerSseClient(res); });
app.get('/admin/logs/snapshot', (_req, res) => { res.json({ logs: getRecentLogs() }); });
app.get('/admin/config', handleGetConfig);
app.post('/admin/config', handlePostConfig);
app.get('/admin/config/running', handleGetRunningConfig);
app.post('/admin/chat', (req, res) => { handleMessages(req, res); });
app.use('/admin', express.static(publicDir, { index: 'index.html' }));
app.get('/admin', (_req, res) => { res.redirect(301, '/admin/'); });

// 健康检查
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: VERSION });
});

// 根路径
app.get('/', (_req, res) => {
    if ((_req.header('accept') || '').includes('text/html')) {
        res.redirect(302, '/admin/');
        return;
    }

    res.json({
        name: 'cursor2api',
        version: VERSION,
        description: 'Cursor Docs AI → Anthropic & OpenAI & Cursor IDE API Proxy',
        endpoints: {
            anthropic_messages: 'POST /v1/messages',
            openai_chat: 'POST /v1/chat/completions',
            openai_responses: 'POST /v1/responses',
            models: 'GET /v1/models',
            proxy_subscriptions: 'GET /v1/proxy/subscriptions',
            proxy_subscriptions_reload: 'POST /v1/proxy/subscriptions/reload',
            airport_runtime: 'GET /v1/airport/runtime',
            health: 'GET /health',
        },
        usage: {
            claude_code: 'export ANTHROPIC_BASE_URL=http://localhost:' + config.port,
            openai_compatible: 'OPENAI_BASE_URL=http://localhost:' + config.port + '/v1',
            cursor_ide: 'OPENAI_BASE_URL=http://localhost:' + config.port + '/v1 (选用 Claude 模型)',
        },
    });
});

// ==================== 启动 ====================

app.listen(config.port, () => {
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log(`  ║        Cursor2API v${VERSION.padEnd(21)}║`);
    console.log('  ╠══════════════════════════════════════╣');
    console.log(`  ║  Server:  http://localhost:${config.port}      ║`);
    console.log('  ║  Model:   ' + config.cursorModel.padEnd(26) + '║');
    console.log('  ╠══════════════════════════════════════╣');
    console.log('  ║  API Endpoints:                      ║');
    console.log('  ║  • Anthropic: /v1/messages            ║');
    console.log('  ║  • OpenAI:   /v1/chat/completions     ║');
    console.log('  ║  • Cursor:   /v1/responses            ║');
    console.log('  ╠══════════════════════════════════════╣');
    console.log('  ║  Claude Code:                        ║');
    console.log(`  ║  export ANTHROPIC_BASE_URL=           ║`);
    console.log(`  ║    http://localhost:${config.port}              ║`);
    console.log('  ║  OpenAI / Cursor IDE:                 ║');
    console.log(`  ║  OPENAI_BASE_URL=                     ║`);
    console.log(`  ║    http://localhost:${config.port}/v1            ║`);
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');
});
