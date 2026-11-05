// Explicit live smoke test: exactly two private messages between verified owned
// accounts. Not part of the offline audit. Never retries an uncertain send.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

if (process.env.QQ_BRIDGE_LIVE_PAIR !== '1') {
  console.log('SKIP live QQ pair test; set QQ_BRIDGE_LIVE_PAIR=1 with --home, --owner and --bot.');
  process.exit(0);
}
const args = Object.fromEntries(process.argv.slice(2).map((value) => {
  const match = /^--(home|owner|bot)=(.+)$/.exec(value);
  if (!match) throw new Error('Expected --home=... --owner=... --bot=...');
  return [match[1], match[2]];
}));
const ids = [args.owner, args.bot];
if (!args.home || ids.some((value) => !/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) || ids[0] === ids[1]) {
  throw new Error('Two distinct explicit account IDs and a SnowLuma home are required');
}
const tag = `QQBridge私聊验收-${crypto.randomBytes(4).toString('hex')}`;
const sockets = [];
const received = new Set();
const sent = [];
const profiles = ids.map((id) => {
  const config = JSON.parse(fs.readFileSync(path.join(args.home, 'config', `onebot_${id}.json`), 'utf8'));
  const http = config.networks?.httpServers?.[0];
  const ws = config.networks?.wsServers?.[0];
  for (const server of [http, ws]) {
    if (!server || !Number.isInteger(server.port) || server.port < 1 || server.port > 65535) throw new Error('Invalid local gateway port');
  }
  return { id, http, ws };
});
const headers = (server) => {
  const token = server.token ?? server.accessToken;
  return token ? { authorization: `Bearer ${token}` } : {};
};
async function rpc(profile, action, body = {}) {
  const res = await fetch(`http://127.0.0.1:${profile.http.port}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers(profile.http) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  const result = await res.json();
  if (!res.ok || result.status !== 'ok' || result.retcode !== 0) throw new Error(`${action}: HTTP ${res.status}, retcode ${result.retcode}`);
  return result.data;
}
async function connect(profile, peer) {
  const url = new URL(`ws://127.0.0.1:${profile.ws.port}${profile.ws.path || '/'}`);
  const token = profile.ws.token ?? profile.ws.accessToken;
  if (token) url.searchParams.set('access_token', token);
  const ws = new WebSocket(url);
  sockets.push(ws);
  ws.addEventListener('message', (messageEvent) => {
    let event; try { event = JSON.parse(String(messageEvent.data)); } catch { return; }
    // Discard every event outside the explicit test pair without retaining it.
    if (event.post_type !== 'message' || event.message_type !== 'private'
      || String(event.self_id) !== profile.id || String(event.user_id) !== peer.id) return;
    const text = typeof event.raw_message === 'string' ? event.raw_message
      : typeof event.message === 'string' ? event.message
        : (event.message ?? []).filter((item) => item.type === 'text').map((item) => item.data?.text ?? '').join('');
    if (text === `${tag} ${peer.id}→${profile.id}`) received.add(profile.id);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Gateway WebSocket open timed out')), 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Gateway WebSocket connection failed')); }, { once: true });
  });
}
try {
  for (const profile of profiles) {
    const login = await rpc(profile, 'get_login_info');
    if (String(login.user_id) !== profile.id) throw new Error('Account identity mismatch; refusing to send');
  }
  await Promise.all([connect(profiles[0], profiles[1]), connect(profiles[1], profiles[0])]);
  for (const [from, to] of [[profiles[0], profiles[1]], [profiles[1], profiles[0]]]) {
    // Record the attempt before awaiting: on timeout its result is uncertain.
    const attempt = { from: from.id, to: to.id, outcome: 'uncertain' };
    sent.push(attempt);
    const result = await rpc(from, 'send_private_msg', { user_id: Number(to.id), message: [{ type: 'text', data: { text: `${tag} ${from.id}→${to.id}` } }] });
    if (!result?.message_id) throw new Error('Gateway returned no message ID; do not retry automatically');
    attempt.outcome = 'acknowledged';
    attempt.messageId = String(result.message_id);
  }
  const deadline = Date.now() + 8000;
  while (received.size < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  console.log(JSON.stringify({ tag, sent, inboundReportedBy: [...received], passed: received.size === 2 }));
  if (received.size !== 2) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ tag, sent, inboundReportedBy: [...received], passed: false, error: error.message }));
  process.exitCode = 1;
} finally {
  for (const ws of sockets) ws.close();
}
