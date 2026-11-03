#!/usr/bin/env node
// 启动前自检：把该一起起来的东西检查一遍，能自动拉起的就拉起。
//
//   node scripts/preflight.mjs                 # 只检查 + 自动拉起 SnowLuma
//   node scripts/preflight.mjs --no-start      # 纯检查，不动任何进程
//
// 做什么：
//   1. 同步 config.json 里的 dsh.baseUrl 到当前 DSH 端口（见 sync-dsh-url.mjs）
//   2. 检查 SnowLuma 的 OneBot HTTP(3010) / WS(3011) 是否在监听，不在就用 launcher.bat 拉起
//   3. 检查控制台端口(3100)有没有被别的进程占着
//
// 约定：这个脚本永远 exit 0。它只是把情况说清楚，不替用户做「要不要继续」的决定；
// 真正的失败交给 bridge 自己报错，避免自检把可以继续的启动拦下来。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(repoRoot, 'config.json');
const noStart = process.argv.includes('--no-start');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function say(msg) {
  console.log(`[preflight] ${msg}`);
}

function isListening(port, host = '127.0.0.1', timeoutMs = 1200) {
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

function runNodeScript(name, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', name), ...args], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve(code ?? 0));
    child.on('error', () => resolve(1));
  });
}

async function readConfig() {
  try {
    return JSON.parse(await fsp.readFile(configPath, 'utf8'));
  } catch (err) {
    say(`读不到 config.json：${err?.message ?? err}`);
    return null;
  }
}

/**
 * 拉起 SnowLuma。
 *
 * 注意：SnowLuma 要求 Node ^24.22.1，而系统 PATH 上的 node 可能是 24.18.0，
 * launcher.bat 里的 check-node-version 会直接 exit 1。它自己目录里带了正确的
 * node.exe（v24.22.1），所以优先用它；没有才退回 launcher.bat。
 */
function launchSnowLuma(homeDir) {
  const entry = path.join(homeDir, 'index.mjs');
  const bundledNode = path.join(homeDir, 'node.exe');
  const logFile = path.join(repoRoot, 'state', 'snowluma-launch.log');

  if (!fs.existsSync(entry)) {
    return { ok: false, reason: `找不到 ${entry}` };
  }

  if (!fs.existsSync(bundledNode)) {
    const launcher = path.join(homeDir, 'launcher.bat');
    if (!fs.existsSync(launcher)) return { ok: false, reason: `找不到 ${launcher}` };
    const child = spawn('cmd.exe', ['/c', 'start', '"SnowLuma"', '/D', homeDir, 'launcher.bat'], {
      cwd: homeDir,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return { ok: true, how: 'launcher.bat', logFile: null };
  }

  let out = 'ignore';
  try {
    const fd = fs.openSync(logFile, 'a');
    out = fd;
  } catch {
    out = 'ignore';
  }

  const child = spawn(bundledNode, [entry], {
    cwd: homeDir,
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  return { ok: true, how: 'node.exe index.mjs', pid: child.pid, logFile };
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isListening(port)) return true;
    await sleep(1500);
  }
  return false;
}

async function main() {
  const config = await readConfig();
  const dshBaseUrl = String(config?.dsh?.baseUrl ?? '');

  // 1) DSH 端口同步
  say('1/3 同步 DSH 地址…');
  await runNodeScript('sync-dsh-url.mjs');
  const synced = await readConfig();
  const base = String(synced?.dsh?.baseUrl ?? dshBaseUrl);
  let dshPort = 0;
  try {
    dshPort = Number(new URL(base).port);
  } catch {
    /* ignore */
  }
  if (dshPort && (await isListening(dshPort))) {
    say(`  DSH 正常：${base}`);
  } else {
    say(`  DSH 没在 ${base || '(空)'} 上跑。请先打开 DeepSeek Harness 桌面版，再重新运行本脚本。`);
  }

  // 2) SnowLuma
  say('2/3 检查 SnowLuma（OneBot 3010 / WS 3011）…');
  const httpUp = await isListening(3010);
  const wsUp = await isListening(3011);
  if (httpUp && wsUp) {
    say('  SnowLuma 正常：3010 / 3011 都在监听');
  } else if (httpUp || wsUp) {
    say(`  SnowLuma 只起来一半（3010 ${httpUp ? '✅' : '❌'} / 3011 ${wsUp ? '✅' : '❌'}），建议去它的窗口看看。`);
  } else {
    say('  SnowLuma 没在跑。');
    const homeDir = String(synced?.snowluma?.homeDir ?? '');
    if (noStart) {
      say('  --no-start：不自动拉起。');
    } else if (!homeDir) {
      say('  config.json 里没有 snowluma.homeDir，请手动打开 SnowLuma。');
    } else {
      const launched = launchSnowLuma(homeDir);
      if (!launched.ok) {
        say(`  自动拉起失败：${launched.reason}`);
      } else {
        say(`  已后台启动 SnowLuma（${launched.how}${launched.pid ? `, pid ${launched.pid}` : ''}），等它就绪（最多 90 秒）…`);
        if (launched.logFile) say(`  它的输出写在 ${launched.logFile}`);
        const ok = await waitForPort(3010, 90000);
        say(ok ? '  SnowLuma 起来了' : '  90 秒内 3010 还没监听：可能需要在 SnowLuma 里扫码登录 QQ，看上面的日志文件');
      }
    }
  }

  // 3) 控制台端口
  say('3/3 检查控制台端口…');
  const consolePort = Number(synced?.consolePort ?? 3100);
  if (await isListening(consolePort)) {
    say(`  ${consolePort} 已被占用：很可能已经有一个桥接在跑（双击 restart.bat 可以重来）。`);
  } else {
    say(`  ${consolePort} 空闲`);
  }
  say('自检结束，接下来由 start.bat 启动桥接。');
}

main().catch((err) => {
  say(`自检出错（不影响启动）：${err?.message ?? err}`);
  process.exit(0);
});
