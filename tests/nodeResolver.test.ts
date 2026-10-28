import assert from 'node:assert';
import { resolveSupportedNode, testNodeExecutable } from '../src/utils/nodeResolver.js';

console.log('[Test] Running nodeResolver test...');
const nodePath = resolveSupportedNode();
console.log('[Test] Resolved supported node path:', nodePath);
assert.ok(nodePath, 'Node path should be resolved');
assert.strictEqual(testNodeExecutable(nodePath), true, 'Resolved node path must support node:sqlite');
console.log('✅ nodeResolver test passed successfully!');
