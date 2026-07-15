import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';

import { createCloudflareD1RestClient } from './cloudflare-d1-rest.mjs';
import { createPasswordHash } from './node-credential-crypto.mjs';
import {
  assertRecoverableAdmin,
  assertRecoveryPostflight,
  assertRecoveryWriteResults,
  buildRecoveryBatch,
  buildRecoveryPostflightQuery,
  buildRecoveryPreflightQuery,
  expectedRecoveryConfirmation,
  parseRecoveryArgs,
  validateRecoveryPassword,
} from './recover-password-core.mjs';

export function promptHidden({ input, output, prompt }) {
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new Error('비밀번호 복구에는 interactive TTY가 필요합니다.'));
  }

  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const wasRaw = input.isRaw === true;
    let value = '';
    let settled = false;
    let rawModeEnabled = false;

    const cleanup = () => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      let cleanupFailed = false;
      if (rawModeEnabled && !wasRaw) {
        try {
          input.setRawMode(false);
        } catch {
          cleanupFailed = true;
        }
      }
      try {
        input.pause();
      } catch {
        cleanupFailed = true;
      }
      return cleanupFailed;
    };

    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      const cleanupFailed = cleanup();
      try {
        output.write('\n');
      } catch {
        reject(new Error('TTY 출력을 쓸 수 없습니다.'));
        return;
      }
      if (error) reject(error);
      else if (cleanupFailed) reject(new Error('TTY 상태를 복구할 수 없습니다.'));
      else resolve(result);
    };

    const onEnd = () => finish(null, new Error('TTY 입력이 종료되었습니다.'));
    const onError = () => finish(null, new Error('TTY 입력을 읽을 수 없습니다.'));
    const onData = (chunk) => {
      let decoded;
      try {
        decoded = decoder.write(
          typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
        );
      } catch {
        finish(null, new Error('TTY 입력을 읽을 수 없습니다.'));
        return;
      }
      for (const character of decoded) {
        if (character === '\u0003') {
          finish(null, new Error('사용자가 취소했습니다.'));
          return;
        }
        if (character === '\u0004') {
          finish(null, new Error('TTY 입력이 종료되었습니다.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          finish(value, null);
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
        } else if (character >= ' ') {
          value += character;
        }
      }
    };

    try {
      output.write(prompt);
      input.setRawMode(true);
      rawModeEnabled = true;
      input.on('data', onData);
      input.once('end', onEnd);
      input.once('error', onError);
      input.resume();
    } catch {
      finish(null, new Error('TTY 입력을 시작할 수 없습니다.'));
    }
  });
}

export function readProductionD1Binding({
  configPath = 'wrangler.toml',
  binding = 'DB',
} = {}) {
  const contents = fs.readFileSync(configPath, 'utf8');
  const matches = contents
    .split('[[d1_databases]]')
    .slice(1)
    .map((block) => ({
      binding: block.match(/^\s*binding\s*=\s*"([^"]+)"/m)?.[1],
      databaseName: block.match(/^\s*database_name\s*=\s*"([^"]+)"/m)?.[1],
      databaseId: block.match(/^\s*database_id\s*=\s*"([^"]+)"/m)?.[1],
    }))
    .filter((entry) => entry.binding === binding);

  if (matches.length !== 1 || !matches[0].databaseName || !matches[0].databaseId) {
    throw new Error(`wrangler.toml에서 ${binding} D1 binding을 정확히 하나 찾을 수 없습니다.`);
  }
  return matches[0];
}

async function defaultQuestion({ input, output, prompt }) {
  const terminal = readline.createInterface({ input, output, terminal: true });
  try {
    return await terminal.question(prompt);
  } finally {
    terminal.close();
  }
}

export async function runPasswordRecovery({
  argv = process.argv.slice(2),
  env = process.env,
  input = process.stdin,
  output = process.stdout,
  fetchImpl = fetch,
  configPath = 'wrangler.toml',
  question = defaultQuestion,
  hiddenPrompt = promptHidden,
  createHash = createPasswordHash,
} = {}) {
  const { username } = parseRecoveryArgs(argv);
  if (!env.CLOUDFLARE_API_TOKEN || !env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error('CLOUDFLARE_API_TOKEN과 CLOUDFLARE_ACCOUNT_ID가 필요합니다.');
  }

  const binding = readProductionD1Binding({ configPath, binding: 'DB' });
  const client = createCloudflareD1RestClient({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
    fetchImpl,
  });
  const preflightResults = await client.query(
    binding.databaseId,
    buildRecoveryPreflightQuery(username),
  );
  assertRecoverableAdmin(preflightResults, username);

  output.write(`Target database: ${binding.databaseName}\nTarget admin: ${username}\n`);
  const expected = expectedRecoveryConfirmation(binding.databaseName, username);
  const confirmation = await question({
    input,
    output,
    prompt: `Type ${expected} to continue: `,
  });
  if (confirmation !== expected) {
    throw new Error('password recovery 확인 문구가 일치하지 않습니다.');
  }

  const password = await hiddenPrompt({ input, output, prompt: 'New password: ' });
  const passwordConfirmation = await hiddenPrompt({
    input,
    output,
    prompt: 'Confirm new password: ',
  });
  validateRecoveryPassword(password, passwordConfirmation);

  let passwordHash;
  try {
    passwordHash = await createHash(password);
  } catch {
    throw new Error('새 비밀번호 hash를 생성할 수 없습니다.');
  }
  const { batch, auditJson } = buildRecoveryBatch({ username, passwordHash });
  const writeResults = await client.query(binding.databaseId, { batch });
  assertRecoveryWriteResults(writeResults);

  const postflightResults = await client.query(
    binding.databaseId,
    buildRecoveryPostflightQuery(username, passwordHash),
  );
  assertRecoveryPostflight(postflightResults, username, auditJson);
  output.write(
    `Password recovery completed for ${binding.databaseName}/${username}; sessions revoked and audit recorded.\n`,
  );
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runPasswordRecovery().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Password recovery failed.');
    process.exitCode = 1;
  });
}
