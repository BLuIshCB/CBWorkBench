import fs from 'node:fs';

const args = process.argv.slice(2);
const scenario = process.env.AGENT_CLI_SCENARIO || args[0] || 'echo';

// 读取 stdin
const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', async () => {
  const fullBuffer = Buffer.concat(chunks);
  const text = fullBuffer.toString('utf8');

  // 记录调用日志（如果设置了日志路径）
  if (process.env.AGENT_CLI_LOG) {
    const logEntry = {
      argv: process.argv,
      cwd: process.cwd(),
      envScenario: process.env.AGENT_CLI_SCENARIO,
      stdinLength: fullBuffer.length,
      stdinSha256: (await import('node:crypto')).createHash('sha256').update(fullBuffer).digest('hex'),
      stdinPreview: text.slice(0, 100),
      timestamp: Date.now(),
    };
    try {
      fs.appendFileSync(process.env.AGENT_CLI_LOG, JSON.stringify(logEntry) + '\n', 'utf8');
    } catch {}
  }

  // 校验参数中是否有 --no-session-persistence
  const hasNoSessionPersistence = args.includes('--no-session-persistence');

  switch (scenario) {
    case 'echo': {
      // 原样输出完整 stdin Buffer
      process.stdout.write(fullBuffer);
      process.exit(0);
      break;
    }

    case 'chunked-utf8': {
      // 故意按字节切割多字节 UTF-8 字符（如中文'你好'与emoji'😀'）分包输出
      const testBuffer = Buffer.from('你好世界😀🌍Hello\n', 'utf8');
      for (let i = 0; i < testBuffer.length; i++) {
        process.stdout.write(testBuffer.subarray(i, i + 1));
        await new Promise(r => setTimeout(r, 2));
      }
      process.exit(0);
      break;
    }

    case 'hang': {
      // 永久挂起模拟超时或取消
      setInterval(() => {}, 10000);
      break;
    }

    case 'exit-code': {
      const code = parseInt(args[1] || '1', 10);
      process.stderr.write(`Exiting with code ${code}\n`);
      process.exit(code);
      break;
    }

    case 'auth-required': {
      process.stderr.write('Error: authentication required. Please run /login first.\n');
      process.exit(1);
      break;
    }

    case 'large-output': {
      // 持续输出大量数据以测试 OUTPUT_LIMIT
      const bigChunk = Buffer.alloc(1024 * 1024, 'A');
      for (let i = 0; i < 30; i++) {
        process.stdout.write(bigChunk);
      }
      process.exit(0);
      break;
    }

    case 'workbuddy-json-success': {
      if (!hasNoSessionPersistence) {
        process.stderr.write('Error: missing required --no-session-persistence flag\n');
        process.exit(1);
      }
      const resp = {
        output: 'WorkBuddy executed successfully: ' + text.trim(),
        model: 'deepseek-v4-flash',
        is_error: false,
      };
      process.stdout.write(JSON.stringify(resp));
      process.exit(0);
      break;
    }

    case 'workbuddy-json-code': {
      if (!hasNoSessionPersistence) {
        process.stderr.write('Error: missing required --no-session-persistence flag\n');
        process.exit(1);
      }
      const resp = {
        output: 'I wrote code:\n```ts\nfunction calculate(x: number) {\n  return { value: x * 2 };\n}\n```',
        model: 'deepseek-v4-flash',
        is_error: false,
      };
      process.stdout.write(JSON.stringify(resp));
      process.exit(0);
      break;
    }

    case 'workbuddy-json-noisy': {
      if (!hasNoSessionPersistence) {
        process.stderr.write('Error: missing required --no-session-persistence flag\n');
        process.exit(1);
      }
      const resp = {
        output: 'Success with nested object: {"done": true}',
        model: 'deepseek-v4-flash',
        is_error: false,
      };
      process.stdout.write('[Banner] Initializing WorkBuddy environment...\n' + JSON.stringify(resp) + '\n[Info] Process done\n');
      process.exit(0);
      break;
    }

    case 'workbuddy-json-error': {
      const resp = {
        output: 'Internal tool error occurred',
        is_error: true,
      };
      process.stdout.write(JSON.stringify(resp));
      process.exit(1);
      break;
    }

    case 'workbuddy-malformed-json': {
      process.stdout.write('{ not valid json ...');
      process.exit(0);
      break;
    }

    case 'inspect-argv': {
      const info = {
        argv: args,
        cwd: process.cwd(),
        hasNoSessionPersistence,
      };
      process.stdout.write(JSON.stringify(info));
      process.exit(0);
      break;
    }

    default:
      process.stdout.write(fullBuffer);
      process.exit(0);
  }
});
