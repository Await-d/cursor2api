import { mkdtempSync, existsSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { handlePostConfig } from '../src/admin-config.ts';

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

process.chdir(tempDir);

try {
    await test('handlePostConfig rejects non-object bodies without writing config.yaml', async () => {
        const req = createMockReq(null);
        const res = createMockRes();

        await handlePostConfig(req, res);

        assert(res.statusCode === 400, `unexpected status: ${res.statusCode}`);
        assert(res.jsonPayload?.ok === false, 'invalid body should return ok=false');
        assert(!existsSync(configPath), 'invalid body should not create config.yaml');
    });

    await test('handlePostConfig writes updated config before resolving', async () => {
        const req = createMockReq({ port: 4010, enable_thinking: true });
        const res = createMockRes();

        await handlePostConfig(req, res);

        assert(res.statusCode === 200, `unexpected status: ${res.statusCode}`);
        assert(res.jsonPayload?.ok === true, 'successful update should return ok=true');
        assert(existsSync(configPath), 'successful update should write config.yaml');

        const parsed = parseYaml(readFileSync(configPath, 'utf-8'));
        assert(parsed.port === 4010, `expected written port 4010, got ${parsed.port}`);
        assert(parsed.enable_thinking === true, 'expected enable_thinking to be persisted');
    });
} finally {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
}

console.log(`\n结果: ${passed} 通过 / ${failed} 失败 / ${passed + failed} 总计`);
if (failed > 0) process.exit(1);
