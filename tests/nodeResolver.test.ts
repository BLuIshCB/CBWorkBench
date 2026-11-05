import assert from 'node:assert';
import { resolveSupportedNode, testNodeExecutable, hasNativeSqlite } from '../src/utils/nodeResolver.js';

console.log('[Test] Running nodeResolver test...');
assert.equal(hasNativeSqlite(), true, 'The Node runtime running this suite supports native sqlite and must be detected in ESM.');
const nodePath = resolveSupportedNode();
console.log('[Test] Resolved supported node path:', nodePath);
assert.ok(nodePath, 'Node path should be resolved');
assert.strictEqual(testNodeExecutable(nodePath), true, 'Resolved node path must support node:sqlite');
console.log('✅ nodeResolver test passed successfully!');
