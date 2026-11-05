import fs from 'node:fs';
if (process.argv.includes('--version')) { console.log('fixture-cli 1.0'); process.exit(0); }
if (process.argv.slice(2).join(' ') !== 'debug models') throw new Error('Unexpected catalog command');
fs.appendFileSync(process.env.CATALOG_LOG, 'catalog\n');
if (process.env.CATALOG_SCENARIO === 'nonzero') { console.error('catalog unavailable'); process.exit(2); }
if (process.env.CATALOG_SCENARIO === 'malformed') console.log('broken JSON');
else console.log(JSON.stringify({ models: process.env.CATALOG_SCENARIO === 'empty' ? [] : [
  { slug: 'model-alpha', visibility: 'list' }, { slug: 'model-beta', visibility: 'list' },
  { slug: 'internal-model', visibility: 'hide' }, { slug: 'model-alpha', visibility: 'list' },
] }));
