import type { Response } from 'express';

export interface LogEntry {
    ts: string;
    level: 'log' | 'info' | 'warn' | 'error';
    msg: string;
}

const MAX_BUFFER = 2000;
const logBuffer: LogEntry[] = [];
const sseClients = new Set<Response>();

function formatArgs(args: unknown[]): string {
    return args
        .map(a => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch { return String(a); }
        })
        .join(' ');
}

function sseFrame(entry: LogEntry): string {
    return 'data: ' + JSON.stringify(entry) + '\n\n';
}

function pushLog(level: LogEntry['level'], args: unknown[]): void {
    const entry: LogEntry = { ts: new Date().toISOString(), level, msg: formatArgs(args) };
    logBuffer.push(entry);
    if (logBuffer.length > MAX_BUFFER) logBuffer.shift();
    const frame = sseFrame(entry);
    for (const res of sseClients) {
        try { res.write(frame); } catch { sseClients.delete(res); }
    }
}

export function initWebLogger(): void {
    const _log = console.log.bind(console);
    const _info = console.info.bind(console);
    const _warn = console.warn.bind(console);
    const _error = console.error.bind(console);
    console.log = (...args: unknown[]) => { _log(...args); pushLog('log', args); };
    console.info = (...args: unknown[]) => { _info(...args); pushLog('info', args); };
    console.warn = (...args: unknown[]) => { _warn(...args); pushLog('warn', args); };
    console.error = (...args: unknown[]) => { _error(...args); pushLog('error', args); };
}

export function getRecentLogs(limit = MAX_BUFFER): LogEntry[] {
    return logBuffer.slice(-limit);
}

export function registerSseClient(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    for (const entry of logBuffer) {
        res.write(sseFrame(entry));
    }
    sseClients.add(res);
    res.on('close', () => { sseClients.delete(res); });
}
