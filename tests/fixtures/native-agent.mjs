import fs from 'node:fs';
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString('utf8');
const provider = process.env.PROVIDER;
const prompt = provider === 'antigravity' ? JSON.parse(input).message.content : input;
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ args, prompt }) + '\n');
const scenario = process.env.SCENARIO;
const response = scenario === 'empty' ? '' : prompt;
if (scenario.startsWith('array')) console.log(JSON.stringify([
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: response }] },
  ...(scenario === 'array-missing-result' ? [] : [{ type: 'result', subtype: scenario === 'array-error' ? 'error_during_execution' : 'success', result: response, is_error: scenario === 'array-error' }]),
]));
else if (scenario === 'malformed') process.stdout.write('{broken');
else if (provider === 'codex') {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: response } }));
  console.log(JSON.stringify(scenario === 'failure' ? { type: 'turn.failed', error: { message: 'provider failed' } } : { type: 'turn.completed', usage: {} }));
} else if (provider === 'antigravity') {
  console.log(JSON.stringify({ event: 'result', result: { status: scenario === 'failure' ? 'ERROR' : 'SUCCESS', response } }));
} else console.log(JSON.stringify({ type: 'result', is_error: scenario === 'failure', result: response }));
process.exitCode = scenario === 'nonzero' ? 2 : 0;
