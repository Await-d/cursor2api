const WELL_KNOWN_TOOLS = new Set([
    'attempt_completion', 'ask_followup_question',
    'AskFollowupQuestion', 'AttemptCompletion',
].map(name => name.toLowerCase()));

export function isWellKnownToolName(name?: string): boolean {
    if (!name) return false;
    return WELL_KNOWN_TOOLS.has(name.toLowerCase());
}
