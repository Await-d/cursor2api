import type { AnthropicResponse, CursorEventUsage, CursorMetadataUsage, CursorSSEEvent, CursorUsage } from './types.js';

type OpenAIUsageDetails = {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: {
        cached_tokens?: number;
        uncached_tokens?: number;
    };
    completion_tokens_details?: {
        reasoning_tokens?: number;
        text_tokens?: number;
    };
};

type UsageCostEstimate = {
    cacheReadTokens: number;
    inputTokens: number;
    outputTokens: number;
    pricingModel: string;
    totalUsd: number;
};

type UsageLogOptions = {
    model: string;
    source: 'cursor' | 'estimated';
    stream: boolean;
    usage: CursorUsage;
};

type PricingProfile = {
    cacheReadUsdPerMillion: number;
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
    patterns: string[];
    pricingModel: string;
};

const PRICING_PROFILES: PricingProfile[] = [
    { patterns: ['claude-sonnet-4.6'], pricingModel: 'claude-4.6-sonnet', inputUsdPerMillion: 3, cacheReadUsdPerMillion: 0.3, outputUsdPerMillion: 15 },
    { patterns: ['claude-opus-4.6-fast'], pricingModel: 'claude-4.6-opus-fast', inputUsdPerMillion: 30, cacheReadUsdPerMillion: 3, outputUsdPerMillion: 150 },
    { patterns: ['claude-opus-4.6'], pricingModel: 'claude-4.6-opus', inputUsdPerMillion: 5, cacheReadUsdPerMillion: 0.5, outputUsdPerMillion: 25 },
    { patterns: ['claude-sonnet-4.5'], pricingModel: 'claude-4.5-sonnet', inputUsdPerMillion: 3, cacheReadUsdPerMillion: 0.3, outputUsdPerMillion: 15 },
    { patterns: ['claude-haiku-4.5'], pricingModel: 'claude-4.5-haiku', inputUsdPerMillion: 1, cacheReadUsdPerMillion: 0.1, outputUsdPerMillion: 5 },
    { patterns: ['claude-opus-4.5'], pricingModel: 'claude-4.5-opus', inputUsdPerMillion: 5, cacheReadUsdPerMillion: 0.5, outputUsdPerMillion: 25 },
    { patterns: ['claude-sonnet-4'], pricingModel: 'claude-4-sonnet', inputUsdPerMillion: 3, cacheReadUsdPerMillion: 0.3, outputUsdPerMillion: 15 },
    { patterns: ['composer-2'], pricingModel: 'composer-2', inputUsdPerMillion: 0.5, cacheReadUsdPerMillion: 0.2, outputUsdPerMillion: 2.5 },
    { patterns: ['composer-1.5'], pricingModel: 'composer-1.5', inputUsdPerMillion: 3.5, cacheReadUsdPerMillion: 0.35, outputUsdPerMillion: 17.5 },
    { patterns: ['composer-1'], pricingModel: 'composer-1', inputUsdPerMillion: 1.25, cacheReadUsdPerMillion: 0.125, outputUsdPerMillion: 10 },
    { patterns: ['gemini-2.5-flash'], pricingModel: 'gemini-2.5-flash', inputUsdPerMillion: 0.3, cacheReadUsdPerMillion: 0.03, outputUsdPerMillion: 2.5 },
    { patterns: ['gemini-3-flash'], pricingModel: 'gemini-3-flash', inputUsdPerMillion: 0.5, cacheReadUsdPerMillion: 0.05, outputUsdPerMillion: 3 },
    { patterns: ['gemini-3-pro-image-preview'], pricingModel: 'gemini-3-pro-image-preview', inputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.2, outputUsdPerMillion: 12 },
    { patterns: ['gemini-3.1-pro', 'gemini-3-1-pro'], pricingModel: 'gemini-3.1-pro', inputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.2, outputUsdPerMillion: 12 },
    { patterns: ['gemini-3-pro'], pricingModel: 'gemini-3-pro', inputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.2, outputUsdPerMillion: 12 },
    { patterns: ['gpt-5.4-nano'], pricingModel: 'gpt-5.4-nano', inputUsdPerMillion: 0.2, cacheReadUsdPerMillion: 0.02, outputUsdPerMillion: 1.25 },
    { patterns: ['gpt-5.4-mini'], pricingModel: 'gpt-5.4-mini', inputUsdPerMillion: 0.75, cacheReadUsdPerMillion: 0.075, outputUsdPerMillion: 4.5 },
    { patterns: ['gpt-5.4'], pricingModel: 'gpt-5.4', inputUsdPerMillion: 2.5, cacheReadUsdPerMillion: 0.25, outputUsdPerMillion: 15 },
    { patterns: ['gpt-5.3-codex'], pricingModel: 'gpt-5.3-codex', inputUsdPerMillion: 1.75, cacheReadUsdPerMillion: 0.175, outputUsdPerMillion: 14 },
    { patterns: ['gpt-5.2-codex'], pricingModel: 'gpt-5.2-codex', inputUsdPerMillion: 1.75, cacheReadUsdPerMillion: 0.175, outputUsdPerMillion: 14 },
    { patterns: ['gpt-5.2'], pricingModel: 'gpt-5.2', inputUsdPerMillion: 1.75, cacheReadUsdPerMillion: 0.175, outputUsdPerMillion: 14 },
    { patterns: ['gpt-5.1-codex-max'], pricingModel: 'gpt-5.1-codex-max', inputUsdPerMillion: 1.25, cacheReadUsdPerMillion: 0.125, outputUsdPerMillion: 10 },
    { patterns: ['gpt-5.1-codex-mini'], pricingModel: 'gpt-5.1-codex-mini', inputUsdPerMillion: 0.25, cacheReadUsdPerMillion: 0.025, outputUsdPerMillion: 2 },
    { patterns: ['gpt-5.1-codex'], pricingModel: 'gpt-5.1-codex', inputUsdPerMillion: 1.25, cacheReadUsdPerMillion: 0.125, outputUsdPerMillion: 10 },
    { patterns: ['gpt-5-codex'], pricingModel: 'gpt-5-codex', inputUsdPerMillion: 1.25, cacheReadUsdPerMillion: 0.125, outputUsdPerMillion: 10 },
    { patterns: ['gpt-5-fast'], pricingModel: 'gpt-5-fast', inputUsdPerMillion: 2.5, cacheReadUsdPerMillion: 0.25, outputUsdPerMillion: 20 },
    { patterns: ['gpt-5-mini'], pricingModel: 'gpt-5-mini', inputUsdPerMillion: 0.25, cacheReadUsdPerMillion: 0.025, outputUsdPerMillion: 2 },
    { patterns: ['gpt-5'], pricingModel: 'gpt-5', inputUsdPerMillion: 1.25, cacheReadUsdPerMillion: 0.125, outputUsdPerMillion: 10 },
    { patterns: ['grok-4.20'], pricingModel: 'grok-4.20', inputUsdPerMillion: 2, cacheReadUsdPerMillion: 0.2, outputUsdPerMillion: 6 },
    { patterns: ['kimi-k2.5', 'kimi-k2-5'], pricingModel: 'kimi-k2.5', inputUsdPerMillion: 0.6, cacheReadUsdPerMillion: 0.1, outputUsdPerMillion: 3 },
];

function readNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeModel(model: string): string {
    return model.trim().toLowerCase();
}

function resolvePricingProfile(model: string): PricingProfile | undefined {
    const normalizedModel = normalizeModel(model);
    return PRICING_PROFILES.find(profile => profile.patterns.some(pattern => normalizedModel.includes(pattern)));
}

function mergeMetadataUsage(primary?: CursorMetadataUsage, secondary?: CursorMetadataUsage): CursorMetadataUsage | undefined {
    if (!primary && !secondary) return undefined;

    return {
        ...secondary,
        ...primary,
        inputTokenDetails: {
            ...secondary?.inputTokenDetails,
            ...primary?.inputTokenDetails,
        },
        outputTokenDetails: {
            ...secondary?.outputTokenDetails,
            ...primary?.outputTokenDetails,
        },
    };
}

function usageCompletenessScore(usage?: CursorUsage): number {
    if (!usage) return -1;

    let score = 0;
    score += usage.inputTokens > 0 ? 1 : 0;
    score += usage.outputTokens > 0 ? 1 : 0;
    score += usage.totalTokens > 0 ? 1 : 0;
    score += typeof usage.reasoningTokens === 'number' ? 1 : 0;
    score += typeof usage.cachedInputTokens === 'number' ? 1 : 0;
    score += typeof usage.inputTokenDetails?.noCacheTokens === 'number' ? 1 : 0;
    score += typeof usage.inputTokenDetails?.cacheReadTokens === 'number' ? 1 : 0;
    score += typeof usage.outputTokenDetails?.textTokens === 'number' ? 1 : 0;
    score += typeof usage.outputTokenDetails?.reasoningTokens === 'number' ? 1 : 0;
    return score;
}

export function preferCursorUsage(current?: CursorUsage, candidate?: CursorUsage): CursorUsage | undefined {
    if (!candidate) return current;
    if (!current) return candidate;
    return usageCompletenessScore(candidate) >= usageCompletenessScore(current) ? candidate : current;
}

export function normalizeCursorUsage(
    eventUsage?: CursorEventUsage,
    metadataUsage?: CursorMetadataUsage,
): CursorUsage | undefined {
    const mergedMetadataUsage = mergeMetadataUsage(metadataUsage);

    if (mergedMetadataUsage) {
        const inputTokens = readNumber(mergedMetadataUsage.inputTokens) ?? readNumber(eventUsage?.prompt_tokens) ?? 0;
        const outputTokens = readNumber(mergedMetadataUsage.outputTokens) ?? readNumber(eventUsage?.completion_tokens) ?? 0;
        const totalTokens = readNumber(mergedMetadataUsage.totalTokens)
            ?? readNumber(eventUsage?.total_tokens)
            ?? (inputTokens + outputTokens);
        const reasoningTokens = readNumber(mergedMetadataUsage.reasoningTokens)
            ?? readNumber(mergedMetadataUsage.outputTokenDetails?.reasoningTokens);
        const cachedInputTokens = readNumber(mergedMetadataUsage.cachedInputTokens)
            ?? readNumber(mergedMetadataUsage.inputTokenDetails?.cacheReadTokens);

        if (inputTokens > 0 || outputTokens > 0 || totalTokens > 0) {
            return {
                inputTokens,
                outputTokens,
                totalTokens,
                ...(typeof reasoningTokens === 'number' ? { reasoningTokens } : {}),
                ...(typeof cachedInputTokens === 'number' ? { cachedInputTokens } : {}),
                ...(mergedMetadataUsage.inputTokenDetails ? { inputTokenDetails: mergedMetadataUsage.inputTokenDetails } : {}),
                ...(mergedMetadataUsage.outputTokenDetails ? { outputTokenDetails: mergedMetadataUsage.outputTokenDetails } : {}),
                isReal: true,
            };
        }
    }

    if (eventUsage) {
        const inputTokens = readNumber(eventUsage.prompt_tokens) ?? 0;
        const outputTokens = readNumber(eventUsage.completion_tokens) ?? 0;
        const totalTokens = readNumber(eventUsage.total_tokens) ?? (inputTokens + outputTokens);

        if (inputTokens > 0 || outputTokens > 0 || totalTokens > 0) {
            return {
                inputTokens,
                outputTokens,
                totalTokens,
                isReal: true,
            };
        }
    }

    return undefined;
}

export function extractCursorUsageFromEvent(event: CursorSSEEvent): CursorUsage | undefined {
    const mergedMetadataUsage = mergeMetadataUsage(
        event.metadata?.usage,
        event.assistant?.metadata?.usage,
    );

    return normalizeCursorUsage(
        event.usage,
        mergedMetadataUsage,
    );
}

export function toAnthropicUsage(cursorUsage?: CursorUsage, fallback?: AnthropicResponse['usage']): AnthropicResponse['usage'] {
    if (!cursorUsage) {
        return fallback ?? { input_tokens: 0, output_tokens: 0 };
    }

    return {
        input_tokens: cursorUsage.inputTokens,
        output_tokens: cursorUsage.outputTokens,
        ...(typeof cursorUsage.cachedInputTokens === 'number'
            ? { cache_read_input_tokens: cursorUsage.cachedInputTokens }
            : {}),
    };
}

export function toAnthropicStreamStartUsage(cursorUsage?: CursorUsage, fallbackInputTokens = 0): AnthropicResponse['usage'] {
    if (!cursorUsage) {
        return { input_tokens: fallbackInputTokens, output_tokens: 0 };
    }

    return {
        input_tokens: cursorUsage.inputTokens,
        output_tokens: 0,
        ...(typeof cursorUsage.cachedInputTokens === 'number'
            ? { cache_read_input_tokens: cursorUsage.cachedInputTokens }
            : {}),
    };
}

export function toAnthropicStreamDeltaUsage(cursorUsage?: CursorUsage, fallbackOutputTokens = 0): AnthropicResponse['usage'] {
    if (!cursorUsage) {
        return { input_tokens: 0, output_tokens: fallbackOutputTokens };
    }

    return {
        input_tokens: cursorUsage.inputTokens,
        output_tokens: cursorUsage.outputTokens,
        ...(typeof cursorUsage.cachedInputTokens === 'number'
            ? { cache_read_input_tokens: cursorUsage.cachedInputTokens }
            : {}),
    };
}

export function toOpenAIUsage(cursorUsage?: CursorUsage, fallback?: OpenAIUsageDetails): OpenAIUsageDetails {
    if (!cursorUsage) {
        return fallback ?? {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        };
    }

    return {
        prompt_tokens: cursorUsage.inputTokens,
        completion_tokens: cursorUsage.outputTokens,
        total_tokens: cursorUsage.totalTokens,
        ...(typeof cursorUsage.cachedInputTokens === 'number' || typeof cursorUsage.inputTokenDetails?.noCacheTokens === 'number'
            ? {
                prompt_tokens_details: {
                    ...(typeof cursorUsage.cachedInputTokens === 'number'
                        ? { cached_tokens: cursorUsage.cachedInputTokens }
                        : {}),
                    ...(typeof cursorUsage.inputTokenDetails?.noCacheTokens === 'number'
                        ? { uncached_tokens: cursorUsage.inputTokenDetails.noCacheTokens }
                        : {}),
                },
            }
            : {}),
        ...(typeof cursorUsage.reasoningTokens === 'number' || typeof cursorUsage.outputTokenDetails?.textTokens === 'number'
            ? {
                completion_tokens_details: {
                    ...(typeof cursorUsage.reasoningTokens === 'number'
                        ? { reasoning_tokens: cursorUsage.reasoningTokens }
                        : {}),
                    ...(typeof cursorUsage.outputTokenDetails?.textTokens === 'number'
                        ? { text_tokens: cursorUsage.outputTokenDetails.textTokens }
                        : {}),
                },
            }
            : {}),
    };
}

export function estimateCursorUsageCost(model: string, usage: CursorUsage): UsageCostEstimate | undefined {
    const pricingProfile = resolvePricingProfile(model);
    if (!pricingProfile) return undefined;

    const cacheReadTokens = usage.cachedInputTokens ?? usage.inputTokenDetails?.cacheReadTokens ?? 0;
    const directInputTokens = usage.inputTokenDetails?.noCacheTokens ?? Math.max(0, usage.inputTokens - cacheReadTokens);
    const outputTokens = usage.outputTokens;

    const totalUsd =
        (directInputTokens * pricingProfile.inputUsdPerMillion) / 1_000_000 +
        (cacheReadTokens * pricingProfile.cacheReadUsdPerMillion) / 1_000_000 +
        (outputTokens * pricingProfile.outputUsdPerMillion) / 1_000_000;

    return {
        pricingModel: pricingProfile.pricingModel,
        inputTokens: directInputTokens,
        cacheReadTokens,
        outputTokens,
        totalUsd,
    };
}

export function buildUsageCostLog(prefix: string, options: UsageLogOptions): string {
    const costEstimate = estimateCursorUsageCost(options.model, options.usage);
    const parts = [
        `source=${options.source}`,
        `stream=${options.stream}`,
        `model=${options.model}`,
        `input_tokens=${options.usage.inputTokens}`,
        `output_tokens=${options.usage.outputTokens}`,
        `total_tokens=${options.usage.totalTokens}`,
        typeof options.usage.cachedInputTokens === 'number' ? `cache_read_tokens=${options.usage.cachedInputTokens}` : null,
        typeof options.usage.reasoningTokens === 'number' ? `reasoning_tokens=${options.usage.reasoningTokens}` : null,
        costEstimate ? `estimated_cost_usd=${costEstimate.totalUsd.toFixed(6)}` : 'estimated_cost_usd=unavailable',
        costEstimate ? `pricing_model=${costEstimate.pricingModel}` : null,
    ].filter((part): part is string => Boolean(part));

    return `[${prefix}] 返回 usage/cost: ${parts.join(', ')}`;
}
