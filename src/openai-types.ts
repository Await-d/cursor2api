// ==================== OpenAI API Types ====================

export interface OpenAIChatRequest {
    model: string;
    messages: OpenAIMessage[];
    stream?: boolean;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    max_completion_tokens?: number;
    tools?: OpenAITool[];
    tool_choice?: string | { type: string; function?: { name: string } };
    response_format?: OpenAIResponseFormat;
    reasoning_effort?: 'low' | 'medium' | 'high' | string;
    stop?: string | string[];
    n?: number;
    frequency_penalty?: number;
    presence_penalty?: number;
}

export interface OpenAIResponseFormat {
    type: 'text' | 'json_object' | 'json_schema';
    json_schema?: {
        name?: string;
        schema?: Record<string, unknown>;
    };
}

export interface OpenAIMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | OpenAIContentPart[] | null;
    name?: string;
    reasoning_content?: string | null;
    // assistant tool_calls
    tool_calls?: OpenAIToolCall[];
    // tool result
    tool_call_id?: string;
}

export interface OpenAIContentPart {
    type: 'text' | 'image_url' | 'reasoning' | 'reasoning_content' | 'input_text' | 'output_text';
    text?: string;
    reasoning?: string;
    image_url?: { url: string; detail?: string };
}

export interface OpenAITool {
    type: 'function';
    function: {
        name: string;
        description?: string;
        parameters?: Record<string, unknown>;
    };
}

export interface OpenAIToolCall {
    id: string;
    type: 'function';
    function: {
        name: string;
        arguments: string;
    };
}

import type { CursorUsage } from './types.js';

// ==================== OpenAI Response Types ====================

export interface OpenAIChatCompletion {
    id: string;
    object: 'chat.completion';
    created: number;
    model: string;
    choices: OpenAIChatChoice[];
    usage: {
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
    cursor_usage?: CursorUsage;
}

export interface OpenAIChatChoice {
    index: number;
    message: {
        role: 'assistant';
        content: string | null;
        reasoning_content?: string;
        tool_calls?: OpenAIToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | null;
}

// ==================== OpenAI Stream Types ====================

export interface OpenAIChatCompletionChunk {
    id: string;
    object: 'chat.completion.chunk';
    created: number;
    model: string;
    choices: OpenAIStreamChoice[];
    usage?: {
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
    cursor_usage?: CursorUsage;
}

export interface OpenAIStreamChoice {
    index: number;
    delta: {
        role?: 'assistant';
        content?: string | null;
        reasoning_content?: string;
        tool_calls?: OpenAIStreamToolCall[];
    };
    finish_reason: 'stop' | 'tool_calls' | 'length' | null;
}

export interface OpenAIStreamToolCall {
    index: number;
    id?: string;
    type?: 'function';
    function: {
        name?: string;
        arguments: string;
    };
}
