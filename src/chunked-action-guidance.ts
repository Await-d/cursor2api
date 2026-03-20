export const CHUNKED_ACTION_PAYLOAD_MAX_CHARS = 1200;
export const CHUNKED_ACTION_PAYLOAD_MAX_LINES = 120;

const WRITE_LIKE_ACTION_PATTERN = /"tool"\s*:\s*"(?:write|edit|multiedit|notebookedit|write_file|edit_file|replace_in_file)"/i;
const WRITE_LIKE_PAYLOAD_FIELD_PATTERN = /"(?:content|newString|new_string|file_text)"\s*:/i;
const WRITE_LIKE_TOOL_CAPTURE = /"tool"\s*:\s*"([^"]+)"/i;
const FILE_PATH_CAPTURE = /"(?:filePath|file_path|path)"\s*:\s*"([^"]+)"/i;

export function shouldUseChunkedActionGuidance(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length < 600) return false;
    return WRITE_LIKE_ACTION_PATTERN.test(trimmed) && WRITE_LIKE_PAYLOAD_FIELD_PATTERN.test(trimmed);
}

export function getChunkedActionGuidance(options: { restart?: boolean; firstOnly?: boolean } = {}): string {
    const opening = options.restart
        ? 'Do not continue the same oversized write/edit JSON string.'
        : 'Do not emit one oversized write/edit action.';
    const ending = options.firstOnly
        ? 'Emit only the first next concrete json action block now.'
        : 'Emit only the next small staged action block now.';

    return `${opening} Instead, create or update the file in smaller staged actions: start with a short scaffold or the smallest safe first edit, then continue with chunk 1/N, chunk 2/N, and so on. If append is unavailable, use the smallest unambiguous follow-up edit/write action for the next chunk. Keep every content/newString payload under ${CHUNKED_ACTION_PAYLOAD_MAX_CHARS} characters and under ${CHUNKED_ACTION_PAYLOAD_MAX_LINES} lines. ${ending}`;
}

export function getConditionalChunkedActionGuidance(
    text: string,
    options: { restart?: boolean; firstOnly?: boolean } = {},
): string {
    return shouldUseChunkedActionGuidance(text) ? ` ${getChunkedActionGuidance(options)}` : '';
}

export function buildChunkedActionRetryAssistantText(text: string): string {
    if (!shouldUseChunkedActionGuidance(text)) {
        return text || '(no response)';
    }

    const toolName = text.match(WRITE_LIKE_TOOL_CAPTURE)?.[1] ?? 'write';
    const filePath = text.match(FILE_PATH_CAPTURE)?.[1];
    const target = filePath ? ` for ${filePath}` : '';
    return `Previous response attempted an oversized ${toolName} action${target} and was truncated before a complete payload could be recovered. Ignore that partial payload and re-emit the next step as smaller staged action blocks.`;
}
