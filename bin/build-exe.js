#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import esbuild from 'esbuild';
import { inject } from 'postject';
import { resolveSupportedNode } from '../src/utils/nodeResolver.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const uiDir = path.join(rootDir, 'src', 'ui');
const embeddedAssetsFile = path.join(uiDir, 'embeddedAssets.ts');

async function build() {
  console.log('============================================================');
  console.log('📦 开始构建 CBWorkBench 独立可执行程序 (EXE)...');
  console.log('============================================================');

  // 1. 查找 Node 24 基础运行时
  const nodeExecutable = resolveSupportedNode();
  console.log(`[1/6] 找到 Node 24 运行时: ${nodeExecutable}`);

  // 2. 扫描并嵌入 UI 静态资源
  console.log('[2/6] 打包 UI 静态资源 (HTML/CSS/JS)...');
  function getMimeType(filePath) {
    if (filePath.endsWith('.html')) return 'text/html';
    if (filePath.endsWith('.css')) return 'text/css';
    if (filePath.endsWith('.js')) return 'application/javascript';
    if (filePath.endsWith('.json')) return 'application/json';
    if (filePath.endsWith('.svg')) return 'image/svg+xml';
    return 'text/plain';
  }

  function scanDir(dir, prefix = '') {
    let entries = {};
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (item.name === 'embeddedAssets.ts') continue;
      const fullPath = path.join(dir, item.name);
      const relKey = (prefix + '/' + item.name).replace(/\\/g, '/');
      if (item.isDirectory()) {
        Object.assign(entries, scanDir(fullPath, relKey));
      } else if (item.isFile()) {
        const content = fs.readFileSync(fullPath, 'utf8');
        entries[relKey] = {
          content,
          contentType: getMimeType(item.name)
        };
      }
    }
    return entries;
  }

  const assets = scanDir(uiDir);
  console.log(`      已收集 ${Object.keys(assets).length} 个 UI 静态资源文件`);

  // 写入 embeddedAssets.ts
  const embeddedTsContent = `export interface EmbeddedAsset {
  content: string;
  contentType: string;
}

export const EMBEDDED_ASSETS: Record<string, EmbeddedAsset> = ${JSON.stringify(assets, null, 2)};
`;
  fs.writeFileSync(embeddedAssetsFile, embeddedTsContent, 'utf8');

  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const bundleFile = path.join(distDir, 'sea-bundle.cjs');
  const seaConfigFile = path.join(distDir, 'sea-config.json');
  const seaBlobFile = path.join(distDir, 'sea-prep.blob');
  const targetExe = path.join(distDir, 'cb-workbench.exe');
  const rootExe = path.join(rootDir, 'cb-workbench.exe');
  let rootCopied = false;
  let rootLockError = null;

  try {
    // 3. 使用 esbuild 将服务端代码与依赖打包为单一 CJS Bundle
    console.log('[3/6] 使用 esbuild API 打包后端代码与依赖...');
    await esbuild.build({
      entryPoints: [path.join(rootDir, 'src', 'entryExe.ts')],
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'cjs',
      outfile: bundleFile,
      external: ['node:*'],
      define: {
        'import.meta.url': '__import_meta_url'
      },
      banner: {
        js: 'const __node_path = require("node:path"); const __node_url = require("node:url"); if (typeof __filename === "undefined") { var __filename = process.execPath; var __dirname = __node_path.dirname(__filename); } const __import_meta_url = __node_url.pathToFileURL(__filename).href;'
      }
    });

    // 4. 生成 SEA 配置与 Blob
    console.log('[4/6] 生成 Node.js SEA 预备 Blob...');
    fs.writeFileSync(seaConfigFile, JSON.stringify({
      main: path.relative(rootDir, bundleFile).replace(/\\/g, '/'),
      output: path.relative(rootDir, seaBlobFile).replace(/\\/g, '/'),
      disableExperimentalSEAWarning: true
    }, null, 2), 'utf8');

    execFileSync(nodeExecutable, ['--experimental-sea-config', path.relative(rootDir, seaConfigFile)], {
      cwd: rootDir,
      stdio: 'inherit'
    });

    // 5. 复制 Node 二进制并注入 SEA Blob
    console.log('[5/6] 注入 Blob 生成独立 cb-workbench.exe...');
    fs.copyFileSync(nodeExecutable, targetExe);

    const blobBuffer = fs.readFileSync(seaBlobFile);
    await inject(targetExe, 'NODE_SEA_BLOB', blobBuffer, {
      sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
      overwrite: true
    });

    // 复制一份到根目录，方便用户直接双击
    try {
      fs.copyFileSync(targetExe, rootExe);
      rootCopied = true;
    } catch (err) {
      if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
        rootLockError = err;
      } else {
        throw err;
      }
    }
  } finally {
    // 6. 无论成功失败都清理临时嵌入代码与中间文件，保持开发树纯净
    console.log('[6/6] 清理中间临时文件...');
    for (const tmp of [bundleFile, seaConfigFile, seaBlobFile]) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {}
    }

    const cleanEmbeddedTs = `export interface EmbeddedAsset {
  content: string;
  contentType: string;
}

/**
 * Embedded UI assets dictionary.
 * Fallback when static files are bundled inside standalone executables.
 */
export const EMBEDDED_ASSETS: Record<string, EmbeddedAsset> = {};
`;
    fs.writeFileSync(embeddedAssetsFile, cleanEmbeddedTs, 'utf8');
  }

  const outputPath = rootCopied ? rootExe : targetExe;
  const stats = fs.statSync(outputPath);
  const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);

  if (rootLockError) {
    console.warn('\n============================================================');
    console.warn(`⚠️ 已生成最新 EXE: ${targetExe} (${sizeMb} MB)`);
    console.warn(`❌ 但无法覆盖根目录文件 ${rootExe}（文件正在被运行中的 cb-workbench.exe 占用）`);
    console.warn('💡 请先关闭正在运行的 cb-workbench.exe，然后手动覆盖或重新运行 npm run build:exe');
    console.warn('============================================================\n');
    process.exitCode = 1;
    return;
  }

  console.log('\n============================================================');
  console.log('🎉 编译成功！独立单文件可执行程序已生成：');
  console.log(`📍 根目录文件: ${rootExe}`);
  console.log(`📍 构建目录:   ${targetExe}`);
  console.log(`📦 文件大小:   ${sizeMb} MB (内置完整 Node 24 引擎 + 前端 UI + SQLite)`);
  console.log('💡 使用方式:   直接双击 cb-workbench.exe 或通过终端带参运行');
  console.log('============================================================\n');
}

build().catch((err) => {
  console.error('[Build Error]', err);
  process.exit(1);
});
