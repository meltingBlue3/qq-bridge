#!/usr/bin/env node
// 把 config.json 里的 dsh.baseUrl 同步成「当前正在跑的 DSH」。
//
// 为什么需要它：DSH 桌面版每次启动会随机挑一个端口（desktop-preferences.json 里
// "port": 0），而桥接是用固定 baseUrl 连 DSH 的。重启电脑后端口一变，桥接就会
// 连不上，报 ECONNREFUSED 或者一直「DSH 未就绪」。
//
// DSH 启动时会把实际地址打进日志：
//   dsh web: http://127.0.0.1:60904/?token=****
// 本脚本读最近的这条日志，验证端口真的在监听，然后写回 config.json。
//
// 用法：
//   node scripts/sync-dsh-url.mjs                # 自动从日志里找
//   node scripts/sync-dsh-url.mjs --dry-run      # 只打印，不改文件
//   node scripts/sync-dsh-url.mjs --base-url http://127.0.0.1:3080
//   node scripts/sync-dsh-url.mjs --port 3080
//
// 退出码：0 = 已同步/无需改动（即使没找到也不阻塞启动）；1 = 参数错误。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(repoRoot, 'config.json');
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const logsDir = path.join(dshHome, 'logs');

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const flagValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
};

function log(msg) {
  console.log(`[sync-dsh-url] ${msg}`);
}

/** 从一段文本里抽出最后一个 “dsh web: http://host:port” 的地址。 */
function extractBaseUrl(text) {
  const matches = [...String(text).matchAll(/dsh web:\s*(https?:\/\/[^\s?"'\\]+)/g)];
  if (!matches.length) return null;
  const url = matches[matches.length - 1][1];
  try {
    const parsed = new URL(url);
    // 只要 origin，丢掉路径和 token 查询串。
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

/** 从 jsonl 日志里找带时间戳的最后一条，返回 {baseUrl, time}。 */
async function scanJsonl(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
  let best = null;
  for (const line of text.split('\n')) {
    if (!line.includes('dsh web:')) continue;
    const baseUrl = extractBaseUrl(line);
    if (!baseUrl) continue;
    let time = 0;
    try {
      const record = JSON.parse(line);
      if (record?.time) time = Date.parse(record.time) || 0;
    } catch {
      // 不是合法 JSON 就按文件顺序兜底。
    }
    if (!best || time >= best.time) best = { baseUrl, time };
  }
  return best;
}

async function discoverFromLogs() {
  let entries;
  try {
    entries = await fsp.readdir(logsDir);
  } catch {
    return null;
  }
  const jsonl = entries
    .filter((name) => /^desktop-next.*\.jsonl$/.test(name))
    .map((name) => path.join(logsDir, name))
    .sort()
    .reverse()
    .slice(0, 6);

  let best = null;
  for (const file of jsonl) {
    const found = await scanJsonl(file);
    if (found && (!best || found.time >= best.time)) best = found;
  }
  if (best) return best.baseUrl;

  // 兜底：纯文本日志 desktop-next.log
  const plain = path.join(logsDir, 'desktop-next.log');
  try {
    const text = await fsp.readFile(plain, 'utf8');
    return extractBaseUrl(text);
  } catch {
    return null;
  }
}

/** 端口是否真的有人在监听。 */
function isListening(baseUrl, timeoutMs = 1500) {
  let host;
  let port;
  try {
    const u = new URL(baseUrl);
    host = u.hostname;
    port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    return Promise.resolve(false);
  }
  if (!port) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function main() {
  const explicitUrl = flagValue('--base-url');
  const explicitPort = flagValue('--port');

  const raw = await fsp.readFile(configPath, 'utf8');
  const config = JSON.parse(raw);
  const current = String(config?.dsh?.baseUrl ?? '').trim();

  let target = null;
  if (explicitUrl) {
    target = explicitUrl.replace(/\/+$/, '');
  } else if (explicitPort) {
    target = `http://127.0.0.1:${explicitPort}`;
  } else {
    target = await discoverFromLogs();
  }

  if (!target) {
    log('没在 DSH 日志里找到地址（DSH 可能没开过）。保持 config.json 不变。');
    log(`当前配置：${current || '(空)'}`);
    process.exit(0);
  }

  const alive = await isListening(target);
  if (!alive) {
    log(`日志里的地址 ${target} 没有监听，说明 DSH 已经不在这个端口了。保持 config.json 不变。`);
    log(`当前配置：${current || '(空)'} · 请先把 DSH 打开`);
    process.exit(0);
  }

  if (target === current) {
    log(`已经是最新的：${target}`);
    process.exit(0);
  }

  if (dryRun) {
    log(`（dry-run）${current || '(空)'} -> ${target}`);
    process.exit(0);
  }

  config.dsh = config.dsh ?? {};
  config.dsh.baseUrl = target;
  // 保持 2 空格缩进 + 结尾换行，和原文件一致。
  const next = `${JSON.stringify(config, null, 2)}\n`;
  const tmp = `${configPath}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, next, 'utf8');
  await fsp.rename(tmp, configPath);
  log(`${current || '(空)'} -> ${target}（已写入 config.json）`);
}

main().catch((err) => {
  // 同步失败不该挡住启动：打印原因，仍然 exit 0 让 start.bat 继续。
  log(`同步失败：${err?.message ?? err}`);
  process.exit(0);
});
