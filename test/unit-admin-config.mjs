import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse as parseDotenv } from 'dotenv';
import { parse as parseYaml } from 'yaml';
import { handleGetConfig, handlePostConfig } from '../src/admin-config.ts';

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅  ${name}`);
        passed++;
    } catch (error) {
        console.error(`  ❌  ${name}`);
        console.error(`      ${error instanceof Error ? error.message : String(error)}`);
        failed++;
    }
}

function assert(condition, message) {
    if (!condition) throw new Error(message || 'Assertion failed');
}

function createMockReq(body) {
    return { body };
}

function createMockRes() {
    return {
        statusCode: 200,
        jsonPayload: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.jsonPayload = payload;
            return this;
        },
    };
}

console.log('\n📦 admin config\n');

const originalCwd = process.cwd();
const tempDir = mkdtempSync(join(tmpdir(), 'cursor2api-admin-config-'));
const configPath = join(tempDir, 'config.yaml');
const envPath = join(tempDir, '.env.docker');
const originalConfigYamlPath = process.env.CONFIG_YAML_PATH;
const originalAdminEnvFilePath = process.env.ADMIN_ENV_FILE_PATH;

process.chdir(tempDir);
process.env.CONFIG_YAML_PATH = configPath;
process.env.ADMIN_ENV_FILE_PATH = envPath;

try {
    await test('handlePostConfig rejects non-object bodies without writing persisted files', async () => {
        const req = createMockReq(null);
        const res = createMockRes();

        await handlePostConfig(req, res);

        assert(res.statusCode === 400, `unexpected status: ${res.statusCode}`);
        assert(res.jsonPayload?.ok === false, 'invalid body should return ok=false');
        assert(!existsSync(configPath), 'invalid body should not create config.yaml');
        assert(!existsSync(envPath), 'invalid body should not create .env.docker');
    });

    await test('handlePostConfig mirrors env-backed fields into a temp env file', async () => {
        const req = createMockReq({
            port: 4010,
            enable_thinking: true,
            proxy_pool: ['http://proxy-a:7890'],
            model_mapping: { '*': 'anthropic/claude-sonnet-4.6' },
            vision: {
                enabled: true,
                mode: 'api',
                base_url: 'https://example.com/v1/chat/completions',
                api_key: 'demo-key',
                model: 'demo-vision-model',
            },
        });
        const res = createMockRes();

        await handlePostConfig(req, res);

        assert(res.statusCode === 200, `unexpected status: ${res.statusCode}`);
        assert(res.jsonPayload?.ok === true, 'successful update should return ok=true');
        assert(existsSync(configPath), 'successful update should write config.yaml');
        assert(existsSync(envPath), 'successful update should write temp .env.docker');

        const parsed = parseYaml(readFileSync(configPath, 'utf-8'));
        assert(parsed.port === 4010, `expected written port 4010, got ${parsed.port}`);
        assert(parsed.enable_thinking === true, 'expected enable_thinking to be persisted');
        assert(parsed.vision?.enabled === true, 'expected vision config to remain in YAML persistence');

        const envValues = parseDotenv(readFileSync(envPath, 'utf-8'));
        assert(envValues.PORT === '4010', `expected env PORT=4010, got ${envValues.PORT}`);
        assert(envValues.ENABLE_THINKING === 'true', `expected env ENABLE_THINKING=true, got ${envValues.ENABLE_THINKING}`);
        assert(envValues.PROXY_POOL === '["http://proxy-a:7890"]', `expected env PROXY_POOL JSON, got ${envValues.PROXY_POOL}`);
        assert(envValues.MODEL_MAPPING === '{"*":"anthropic/claude-sonnet-4.6"}', `expected env MODEL_MAPPING JSON, got ${envValues.MODEL_MAPPING}`);
    });

    await test('handleGetConfig returns persisted file values instead of stale runtime cache', async () => {
        writeFileSync(configPath, 'port: 4020\nenable_thinking: false\nsystem_prompt_inject: from-yaml\n', 'utf-8');
        writeFileSync(envPath, 'ENABLE_THINKING=true\nSYSTEM_PROMPT_INJECT=from-env\n', 'utf-8');

        const req = createMockReq(undefined);
        const res = createMockRes();

        await handleGetConfig(req, res);

        assert(res.statusCode === 200, `unexpected status: ${res.statusCode}`);
        assert(res.jsonPayload?.ok === true, 'expected ok=true when reading persisted config');
        assert(res.jsonPayload?.config?.port === 4020, `expected persisted port 4020, got ${res.jsonPayload?.config?.port}`);
        assert(res.jsonPayload?.config?.enable_thinking === true, 'expected env-backed enable_thinking=true');
        assert(res.jsonPayload?.config?.system_prompt_inject === 'from-env', 'expected env-backed system prompt to override YAML');
    });

    await test('handlePostConfig keeps multiline system prompt in YAML while leaving env file safe', async () => {
        const req = createMockReq({ system_prompt_inject: 'line-1\nline-2' });
        const res = createMockRes();

        await handlePostConfig(req, res);

        assert(res.statusCode === 200, `unexpected status: ${res.statusCode}`);

        const parsedYaml = parseYaml(readFileSync(configPath, 'utf-8'));
        assert(parsedYaml.system_prompt_inject === 'line-1\nline-2', 'expected multiline system prompt to persist in YAML');

        const envValues = parseDotenv(readFileSync(envPath, 'utf-8'));
        assert(envValues.SYSTEM_PROMPT_INJECT === '', 'expected multiline system prompt to avoid invalid env serialization');
    });
} finally {
    process.chdir(originalCwd);
    if (originalConfigYamlPath === undefined) {
        delete process.env.CONFIG_YAML_PATH;
    } else {
        process.env.CONFIG_YAML_PATH = originalConfigYamlPath;
    }
    if (originalAdminEnvFilePath === undefined) {
        delete process.env.ADMIN_ENV_FILE_PATH;
    } else {
        process.env.ADMIN_ENV_FILE_PATH = originalAdminEnvFilePath;
    }
    rmSync(tempDir, { recursive: true, force: true });
}

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
if (failed > 0) process.exit(1);
