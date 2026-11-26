import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const WINDOWS_RESERVED_NAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

export class PathSecurityError extends Error {
  readonly code: string;
  readonly path?: string;
  constructor(code: string, message: string, filePath?: string) {
    super(message);
    this.name = 'PathSecurityError';
    this.code = code;
    this.path = filePath;
  }
}

/**
 * Computes a collision-free, cross-platform safe directory name for a workflow node ID.
 */
export function encodeNodeDirName(nodeId: string): string {
  const trimmed = nodeId.trim();
  const isSimpleLower = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(trimmed);
  const hasCollisionMarker = /--h[0-9a-f]{8}$/i.test(trimmed);
  if (isSimpleLower && !WINDOWS_RESERVED_NAMES.has(trimmed) && !hasCollisionMarker) {
    return trimmed;
  }
  const slug = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'node';
  const hash = crypto.createHash('sha256').update(nodeId, 'utf8').digest('hex').slice(0, 8);
  return `n_${slug}--h${hash}`;
}

/** 模板节点 ID 同时用作材料目录和同名 Markdown 文件的基本名。 */
export function isWorkflowMaterialNodeId(nodeId: string): boolean {
  return /^[a-z0-9_-]{1,252}$/.test(nodeId) && nodeId !== 'shared' &&
    !WINDOWS_RESERVED_NAMES.has(nodeId);
}

export function workflowMaterialNodeDirName(nodeId: string): string {
  return isWorkflowMaterialNodeId(nodeId) ? nodeId : encodeNodeDirName(nodeId);
}

export function validatePackageRelativePath(relPath: string): {
  valid: boolean;
  reason?: string;
  segments?: string[];
} {
  if (typeof relPath !== 'string' || !relPath) {
    return { valid: false, reason: '路径不能为空' };
  }
  if (relPath !== relPath.trim()) {
    return { valid: false, reason: '路径前后不允许包含空白字符' };
  }
  if (/[\x00-\x1f]/.test(relPath)) {
    return { valid: false, reason: '路径包含非法控制字符' };
  }
  if (relPath.includes('\\')) {
    return { valid: false, reason: '包内路径必须统一使用 "/"，禁止使用反斜杠' };
  }
  if (relPath.startsWith('/')) {
    return { valid: false, reason: '禁止使用绝对路径' };
  }
  if (relPath.endsWith('/')) {
    return { valid: false, reason: '文件路径不能以 "/" 结尾' };
  }
  if (/^[a-zA-Z]:/.test(relPath)) {
    return { valid: false, reason: '禁止包含盘符' };
  }
  if (relPath.startsWith('//')) {
    return { valid: false, reason: '禁止使用网络路径 (UNC)' };
  }

  const segments = relPath.split('/');
  for (const seg of segments) {
    if (!seg) {
      return { valid: false, reason: '路径包含空段 "//"' };
    }
    if (seg === '.' || seg === '..') {
      return { valid: false, reason: '禁止使用 "." 或 ".." 路径段' };
    }
    if (seg.endsWith('.') || seg.endsWith(' ')) {
      return { valid: false, reason: `路径段 "${seg}" 末尾不能包含点或空格` };
    }
    const baseName = seg.split('.')[0].toLowerCase();
    if (WINDOWS_RESERVED_NAMES.has(baseName)) {
      return { valid: false, reason: `路径段 "${seg}" 命中保留设备名` };
    }
  }

  return { valid: true, segments };
}

export function findCaseCollision(paths: string[]): [string, string] | null {
  const seen = new Map<string, string>();
  for (const p of paths) {
    const key = p.toLowerCase();
    const existing = seen.get(key);
    if (existing !== undefined) {
      return [existing, p];
    }
    seen.set(key, p);
  }
  return null;
}

function isInsideRealRoot(rootReal: string, targetReal: string): boolean {
  const cmpRoot = process.platform === 'win32' ? rootReal.toLowerCase() : rootReal;
  const cmpTarget = process.platform === 'win32' ? targetReal.toLowerCase() : targetReal;
  const prefix = cmpRoot.endsWith(path.sep) ? cmpRoot : cmpRoot + path.sep;
  return cmpTarget.startsWith(prefix);
}

/**
 * Safely reads a regular file inside `rootDir` by walking every segment,
 * rejecting symlinks, Windows junctions/reparse points, and root escapes.
 */
export function readRegularFileSafely(rootDir: string, relPath: string, maxBytes?: number): Buffer {
  const check = validatePackageRelativePath(relPath);
  if (!check.valid || !check.segments) {
    throw new PathSecurityError('INVALID_RESOURCE_PATH', `非法包内路径 [${relPath}]: ${check.reason}`, relPath);
  }

  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(rootDir);
  } catch (err: any) {
    throw new PathSecurityError('SOURCE_UNAVAILABLE', `源目录不可访问 (${rootDir}): ${err?.message || err}`, relPath);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new PathSecurityError('SOURCE_UNAVAILABLE', `源目录无效或为符号链接: ${rootDir}`, relPath);
  }

  const rootReal = fs.realpathSync(rootDir);
  let curr = rootDir;
  for (let i = 0; i < check.segments.length; i++) {
    curr = path.join(curr, check.segments[i]);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(curr);
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        throw new PathSecurityError('MISSING_FILE', `文件或目录不存在: ${relPath}`, relPath);
      }
      throw new PathSecurityError('SOURCE_UNAVAILABLE', `无法读取文件状态 (${relPath}): ${err?.message || err}`, relPath);
    }
    if (st.isSymbolicLink()) {
      throw new PathSecurityError('PATH_ESCAPE', `拒绝符号链接或 junction/reparse point 逃逸: ${relPath}`, relPath);
    }
    const isLast = i === check.segments.length - 1;
    if (!isLast && !st.isDirectory()) {
      throw new PathSecurityError('INVALID_RESOURCE_PATH', `路径中间段不是目录: ${relPath}`, relPath);
    }
    if (isLast && !st.isFile()) {
      throw new PathSecurityError('INVALID_RESOURCE_PATH', `仅允许读取普通文件: ${relPath}`, relPath);
    }
    if (isLast && maxBytes !== undefined && st.size > maxBytes) {
      throw new PathSecurityError('SIZE_LIMIT_EXCEEDED', `文件超过 ${maxBytes} 字节: ${relPath}`, relPath);
    }
  }

  const targetReal = fs.realpathSync(curr);
  if (!isInsideRealRoot(rootReal, targetReal)) {
    throw new PathSecurityError('PATH_ESCAPE', `文件路径解析后越界包根目录: ${relPath}`, relPath);
  }

  const content = fs.readFileSync(curr);
  if (maxBytes !== undefined && content.length > maxBytes) {
    throw new PathSecurityError('SIZE_LIMIT_EXCEEDED', `文件超过 ${maxBytes} 字节: ${relPath}`, relPath);
  }
  return content;
}

export function isTextMediaType(mediaType: string, relPath: string): boolean {
  const mt = (mediaType || '').toLowerCase();
  if (mt.startsWith('text/') || mt === 'application/json' || mt.endsWith('+json')) {
    return true;
  }
  return /\.(md|markdown|txt|json|yaml|yml|toml|csv|xml|html|css|js|ts|tsx|jsx|py|sh|ps1)$/i.test(relPath);
}

export function validateUtf8NoBom(buf: Buffer, mediaType: string, relPath: string): void {
  if (!isTextMediaType(mediaType, relPath)) return;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    throw new PathSecurityError('BOM_NOT_ALLOWED', `文本文件禁止包含 UTF-8 BOM: ${relPath}`, relPath);
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new PathSecurityError('INVALID_UTF8', `文本文件不是有效的 UTF-8 编码: ${relPath}`, relPath);
  }
}

export function computeBufferSha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function setFileReadOnly(filePath: string): void {
  try {
    fs.chmodSync(filePath, 0o444);
  } catch {}
}

/**
 * Safely deletes `targetDir` strictly inside `baseDir` without following symlinks
 * and restoring write permissions on read-only files (required on Windows NTFS).
 */
export function safeRemoveDirInsideBase(baseDir: string, targetDir: string): void {
  const baseResolved = path.resolve(baseDir);
  const targetResolved = path.resolve(targetDir);

  if (!isInsideRealRoot(baseResolved, targetResolved)) {
    throw new PathSecurityError('PATH_ESCAPE', `拒绝删除越界目录: ${targetResolved} 不在 ${baseResolved} 内`);
  }

  if (!fs.existsSync(targetResolved)) {
    return;
  }

  const baseReal = fs.existsSync(baseResolved) ? fs.realpathSync(baseResolved) : baseResolved;
  const targetParentReal = fs.realpathSync(path.dirname(targetResolved));
  if (
    targetParentReal !== baseReal &&
    !isInsideRealRoot(baseReal, targetParentReal)
  ) {
    throw new PathSecurityError('PATH_ESCAPE', `目标父目录实际路径越界: ${targetParentReal}`);
  }

  const removeRecursive = (entryPath: string): void => {
    const st = fs.lstatSync(entryPath);
    if (st.isSymbolicLink()) {
      fs.unlinkSync(entryPath);
      return;
    }
    if (st.isDirectory()) {
      try { fs.chmodSync(entryPath, 0o755); } catch {}
      for (const child of fs.readdirSync(entryPath)) {
        removeRecursive(path.join(entryPath, child));
      }
      fs.rmdirSync(entryPath);
      return;
    }
    try { fs.chmodSync(entryPath, 0o666); } catch {}
    fs.unlinkSync(entryPath);
  };

  removeRecursive(targetResolved);
}
