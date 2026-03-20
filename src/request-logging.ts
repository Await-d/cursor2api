import type { Response } from 'express';

type RequestLogMeta = {
    messages?: number;
    model?: string;
    proxyUrl?: string | null;
    statusCode?: number;
    stream?: boolean;
    tools?: number;
    durationMs?: number;
};

function formatValue(value: string | number | boolean | null | undefined): string | null {
    if (value === null || value === undefined || value === '') return null;
    return String(value);
}

export function buildRequestCompletionLog(prefix: string, meta: RequestLogMeta): string {
    const parts = [
        ['status', meta.statusCode],
        ['duration', typeof meta.durationMs === 'number' ? `${meta.durationMs}ms` : undefined],
        ['model', meta.model],
        ['messages', meta.messages],
        ['stream', meta.stream],
        ['tools', meta.tools],
        ['proxy', meta.proxyUrl],
    ].map(([key, value]) => {
        const formatted = formatValue(value as string | number | boolean | null | undefined);
        return formatted ? `${key}=${formatted}` : null;
    }).filter((part): part is string => Boolean(part));

    return `[${prefix}] 请求完成: ${parts.join(', ')}`;
}

export function logRequestCompletion(prefix: string, meta: RequestLogMeta): void {
    console.log(buildRequestCompletionLog(prefix, meta));
}

export function attachResponseCompletionLogging(res: Response, prefix: string, meta: Omit<RequestLogMeta, 'durationMs' | 'statusCode'>): void {
    const startedAt = Date.now();
    let logged = false;
    const subscribe = typeof res.once === 'function'
        ? res.once.bind(res)
        : typeof res.on === 'function'
            ? res.on.bind(res)
            : null;

    if (!subscribe) return;

    const logOnce = () => {
        if (logged) return;
        logged = true;
        logRequestCompletion(prefix, {
            ...meta,
            statusCode: res.statusCode,
            durationMs: Date.now() - startedAt,
        });
    };

    subscribe('finish', logOnce);
}
