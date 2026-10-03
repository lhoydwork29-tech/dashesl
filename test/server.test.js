const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { afterEach, beforeEach, test } = require('node:test');
const { createServer } = require('../server');

const PASSWORD = 'correct-horse-dashboard';
let directory;
let server;
let baseUrl;
let cookie;

beforeEach(async () => {
  directory = fs.mkdtempSync(path.join(__dirname, 'private-data-'));
  server = createServer({ dataDir: directory, password: PASSWORD, sessionSecret: Buffer.alloc(32, 7) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  cookie = '';
});

afterEach(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(directory, { recursive: true, force: true });
});

async function signIn() {
  const response = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(response.status, 200);
  cookie = response.headers.get('set-cookie').split(';', 1)[0];
}

async function api(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { ...(options.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
  });
}

const sampleState = {
  settings: { theme: 'sky' },
  students: [{ id: 'student-1', name: 'Mika' }],
  classes: [{ id: 'class-1', studentId: 'student-1' }],
  payments: {},
  milestones: [],
};

test('protects dashboard data until password sign-in succeeds', async () => {
  const unauthorized = await api('/api/dashboard');
  assert.equal(unauthorized.status, 401);

  const invalidPassword = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' }),
  });
  assert.equal(invalidPassword.status, 401);

  await signIn();
  assert.equal((await api('/api/dashboard')).status, 200);
});

test('initializes one shared dataset and rejects stale revisions without overwriting it', async () => {
  await signIn();
  const empty = await (await api('/api/dashboard')).json();
  assert.deepEqual(empty, { state: null, revision: 0, updatedAt: null });

  const initialized = await api('/api/dashboard', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: sampleState, revision: 0 }),
  });
  assert.equal(initialized.status, 201);
  const saved = await initialized.json();
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.state, sampleState);

  const staleWrite = await api('/api/dashboard', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: { ...sampleState, students: [] }, revision: 0 }),
  });
  assert.equal(staleWrite.status, 409);
  const conflict = await staleWrite.json();
  assert.equal(conflict.revision, 1);
  assert.deepEqual(conflict.state, sampleState);

  const updated = await api('/api/dashboard', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: { ...sampleState, settings: { theme: 'mint' } }, revision: 1 }),
  });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).revision, 2);
});

test('keeps the SQLite dataset across server restarts', async () => {
  await signIn();
  await api('/api/dashboard', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: sampleState, revision: 0 }),
  });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  server = createServer({ dataDir: directory, password: PASSWORD, sessionSecret: Buffer.alloc(32, 7) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await signIn();
  const saved = await (await api('/api/dashboard')).json();
  assert.deepEqual(saved.state, sampleState);
  assert.equal(saved.revision, 1);
});

test('rejects malformed state and serves the dashboard from the same origin', async () => {
  await signIn();
  const invalid = await api('/api/dashboard', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: { students: [] }, revision: 0 }),
  });
  assert.equal(invalid.status, 400);

  const page = await fetch(baseUrl);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);

  const databasePath = `/${path.relative(path.join(__dirname, '..'), path.join(directory, 'dashboard.sqlite')).split(path.sep).join('/')}`;
  const privateFile = await fetch(`${baseUrl}${databasePath}`);
  assert.equal(privateFile.status, 403);
  const gitMetadata = await fetch(`${baseUrl}/.git/config`);
  assert.equal(gitMetadata.status, 404);
});
