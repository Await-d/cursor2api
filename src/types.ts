// ==================== Anthropic API Types ====================

export interface AnthropicRequest {
    model: string;
    messages: AnthropicMessage[];
    max_tokens: number;
    stream?: boolean;
    system?: string | AnthropicContentBlock[];
    tools?: AnthropicTool[];
    tool_choice?: AnthropicToolChoice;
    thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number };
    temperature?: number;
    top_p?: number;
    stop_sequences?: string[];
    _cursor2apiRetryProfile?: RetryPromptProfileId;
    _cursor2apiRetryAttempt?: number;
}

/** tool_choice 控制模型是否必须调用工具
 *  - auto: 模型自行决定（默认）
 *  - any:  必须调用至少一个工具
 *  - tool: 必须调用指定工具
 */
export type AnthropicToolChoice =
    | { type: 'auto' }
    | { type: 'any' }
    | { type: 'tool'; name: string };

export type RetryPromptProfileId =
    | 'tool_role_reset'
    | 'tool_direct_action'
    | 'tool_minimal_context'
    | 'chat_role_reset'
    | 'chat_direct_answer'
    | 'chat_minimal_context';

export interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
    type: 'text' | 'tool_use' | 'tool_result' | 'image' | 'thinking';
    text?: string;
    thinking?: string;
    signature?: string;
    // image fields
    source?: { type: string; media_type?: string; data: string };
    // tool_use fields
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    // tool_result fields
    tool_use_id?: string;
    content?: string | AnthropicContentBlock[];
    is_error?: boolean;
}

export interface AnthropicTool {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
}

export interface AnthropicResponse {
    id: string;
    type: 'message';
    role: 'assistant';
    content: AnthropicContentBlock[];
    model: string;
    stop_reason: string;
    stop_sequence: string | null;
    usage: { input_tokens: number; output_tokens: number };
}

// ==================== Cursor API Types ====================

export interface CursorChatRequest {
    context?: CursorContext[];
    model: string;
    id: string;
    messages: CursorMessage[];
    trigger: string;
}

export interface CursorContext {
    type: string;
    content: string;
    filePath: string;
}

export interface CursorMessage {
    parts: CursorPart[];
    id: string;
    role: string;
}

export interface CursorPart {
    type: string;
    text: string;
}

export interface CursorSSEEvent {
    type: string;
    delta?: string;
    /** upstream usage chunk (some OpenAI-compatible services) */
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
}

// ==================== Internal Types ====================

export interface ParsedToolCall {
    name: string;
    arguments: Record<string, unknown>;
    integrity: 'strict' | 'recovered';
}

export interface ProxySubscriptionConfig {
    name: string;
    url: string;
    enabled: boolean;
    refreshIntervalMs: number;
    format: 'auto' | 'url-list' | 'clash' | 'json';
}

export interface AirportSubscriptionConfig {
    name: string;
    url: string;
    enabled: boolean;
    intervalSeconds: number;
    filter: string;
    excludeFilter: string;
    excludeType: string;
    headers: Record<string, string>;
}

export interface AppConfig {
    port: number;
    timeout: number;
    proxy?: string;
    cursorModel: string;
    concurrency: number;
    queueStatusLogIntervalMs: number;
    queueTimeout: number;
    retryDelay: number;
    maxRetryDelay: number;
    direct429CooldownMs: number;
    proxyHealthCheckIntervalMs: number;
    proxyProbeTimeoutMs: number;
    proxyPauseBaseMs: number;
    proxyPauseMaxMs: number;
    enableThinking: boolean;
    modelMapping: Record<string, string>;
    systemPromptInject: string;
    proxyPool: string[];
    proxySubscriptionRefreshMs: number;
    proxySubscriptionTimeoutMs: number;
    proxySubscriptionMaxBytes: number;
    proxySubscriptionApiEnabled: boolean;
    proxySubscriptionApiToken: string;
    proxySubscriptions: ProxySubscriptionConfig[];
    airportRuntimeBinaryPath: string;
    airportRuntimeSocksPort: number;
    airportRuntimeControlPort: number;
    airportRuntimeWorkDir: string;
    airportRuntimeTestUrl: string;
    airportRuntimeTestIntervalSeconds: number;
    airportRuntimeLogLevel: 'silent' | 'error' | 'warning' | 'info' | 'debug';
    airportRuntimeMode: 'auto' | 'combined' | 'per-subscription';
    airportRuntimeGroupType: 'url-test' | 'load-balance';
    airportRuntimeGroupStrategy: '' | 'round-robin' | 'consistent-hashing' | 'sticky-sessions';
    airportSubscriptions: AirportSubscriptionConfig[];
    vision?: {
        enabled: boolean;
        mode: 'ocr' | 'api';
        baseUrl: string;
        apiKey: string;
        model: string;
    };
    fingerprint: {
        userAgent: string;
    };
}
