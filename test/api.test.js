import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createApi } from '../src/app.js';
import { decodeLogs } from '../src/services/docker.js';

const token = 'a'.repeat(48);
async function fixture(t, overrides = {}) {
  const calls = [];
  const app = createApi({
    apps: { astro: { container: 'astro_calc', healthUrl: 'http://astro_calc:8888/' } }, token,
    logger: () => {},
    docker: async (method, path) => {
      calls.push({ method, path });
      if (method === 'POST') return { status: 204, body: Buffer.alloc(0) };
      return { status: 200, body: Buffer.from(JSON.stringify({ State: { Status: 'running', Running: true, ExitCode: 0 }, HostConfig: { RestartPolicy: { Name: 'no' } }, NetworkSettings: { Networks: { 'demo-network': {} } }, Config: { Tty: false } })) };
    }, fetchHealth: async () => ({ status: 200 }), ...overrides
  });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { calls, request: (path, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers }
  }) };

}
test('unauthenticated management is blocked before Docker access; liveness is public', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/apps/astro/stop', { method: 'POST', headers: { Authorization: '' } })).status, 401);
  assert.equal((await f.request('/livez', { headers: { Authorization: '' } })).status, 200);
  assert.equal(f.calls.length, 0);
});
test('registry prevents access to unrelated containers', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/apps/vstda-agent/stop', { method: 'POST' })).status, 404);
  assert.equal(f.calls.length, 0);
});
test('status exposes selected fields and explicit start targets existing container', async t => {
  const f = await fixture(t);
  const status = await (await f.request('/v1/apps/astro/status')).json();
  assert.equal(status.restartPolicy, 'no');
  assert.deepEqual(status.networks, ['demo-network']);
  assert.equal((await f.request('/v1/apps/astro/start', { method: 'POST' })).status, 200);
  assert.deepEqual(f.calls.at(-1), { method: 'POST', path: '/containers/astro_calc/start?t=10' });
  assert.equal((await f.request('/v1/apps/astro/stop')).status, 405);
});
test('aggregate health fails when app HTTP endpoint is unavailable', async t => {
  const f = await fixture(t, { fetchHealth: async () => { throw new Error('unreachable'); } });
  const response = await f.request('/health');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).apps[0].healthy, false);
});
test('untrusted browser origins are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/apps', { headers: { Origin: 'https://unknown.example' } })).status, 403);
});
test('Docker log frames are decoded', () => {
  const header = Buffer.alloc(8); header[0] = 1; header.writeUInt32BE(6, 4);
  assert.equal(decodeLogs(Buffer.concat([header, Buffer.from('hello\n')]), false), 'hello\n');
});
test('concurrent lifecycle actions on one app are rejected', async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { docker: async (method) => {
    if (method === 'POST') { entered(); await blocked; return { status: 204 }; }
    return { status: 200, body: Buffer.from('{}') };
  } });
  const first = f.request('/v1/apps/astro/stop', { method: 'POST' });
  await ready;
  try { assert.equal((await f.request('/v1/apps/astro/start', { method: 'POST' })).status, 409); }
  finally { release(); }
  assert.equal((await first).status, 200);
});

test('async Docker failures become safe JSON errors', async t => {
  const f = await fixture(t, { docker: async () => { throw new Error('secret backend details'); } });
  const response = await f.request('/v1/apps/astro/status');
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error, 'Backend unavailable or request failed');
});
test('preflight bypasses auth and returns an empty 204', async t => {
  const f = await fixture(t, { origins: ['https://demo.example'] });
  const response = await f.request('/v1/apps', { method: 'OPTIONS', headers: { Authorization: '', Origin: 'https://demo.example' } });
  assert.equal(response.status, 204);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://demo.example');
});
