// 模块安装登记表（V1.1.0）
//
// 目的：区分“随仓库分发的内置模块”和“用户自行安装的模块”。
// - 内置模块：config/builtin-modules.json 快照，只允许禁用，禁止卸载。
// - 用户模块：通过市场或手工安装后登记在 data/modules-registry.json，可卸载。
//
// 这里只做数据读写与判定，不涉及文件删除（见 removal.js）。

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR } from '../config.js';

const REGISTRY_FILE = path.join(DATA_DIR, 'modules-registry.json');
const BUILTIN_FILE = path.join(ROOT, 'config', 'builtin-modules.json');

let builtinCache = null;

export function builtinIds() {
  if (!builtinCache) {
    try {
      const parsed = JSON.parse(fs.readFileSync(BUILTIN_FILE, 'utf8'));
      builtinCache = new Set(Array.isArray(parsed?.modules) ? parsed.modules : []);
    } catch {
      builtinCache = new Set();
    }
  }
  return builtinCache;
}

export function isBuiltin(id) {
  return builtinIds().has(String(id || ''));
}

function readAll() {
  try {
    const parsed = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    return parsed && typeof parsed.modules === 'object' && parsed.modules ? parsed.modules : {};
  } catch {
    return {};
  }
}

function writeAll(modules) {
  fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
  const tmp = `${REGISTRY_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, modules }, null, 2), 'utf8');
  fs.renameSync(tmp, REGISTRY_FILE);
}

export function listInstalled() {
  return readAll();
}

export function getInstalled(id) {
  return readAll()[String(id || '')] || null;
}

export function isUserInstalled(id) {
  return Boolean(getInstalled(id));
}

export function registerInstalled({ id, kind, source = 'manual', meta = {} }) {
  if (!id || !kind) throw new Error('registerInstalled 需要 id 与 kind');
  const modules = readAll();
  modules[id] = {
    id,
    kind,
    source,
    installedAt: new Date().toISOString(),
    ...meta
  };
  writeAll(modules);
  return modules[id];
}

export function unregister(id) {
  const modules = readAll();
  if (!modules[id]) return false;
  delete modules[id];
  writeAll(modules);
  return true;
}
