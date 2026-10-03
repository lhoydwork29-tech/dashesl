const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '..', 'dashboard-sync.js'), 'utf8');

function createHarness({ initialState = null, initialRevision = 0, storage = {} } = {}) {
  let serverState = initialState;
  let revision = initialRevision;
  let online = true;
  const statuses = [];
  const values = new Map(Object.entries(storage));
  const localStorage = {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
  const window = { addEventListener() {} };
  const fetch = async (url, options = {}) => {
    if (!online) throw new Error('network unavailable');
    if (url !== '/api/dashboard') throw new Error(`Unexpected URL: ${url}`);
    if (!options.method || options.method === 'GET') {
      return response(200, { state: serverState, revision, updatedAt: null });
    }
    const body = JSON.parse(options.body);
    if (body.revision !== revision) {
      return response(409, {
        error: 'Stale revision.',
        state: serverState,
        revision,
        updatedAt: null,
      });
    }
    serverState = body.state;
    revision += 1;
    return response(200, { state: serverState, revision, updatedAt: null });
  };
  const context = {
    AbortController,
    Blob,
    Date,
    URL,
    clearTimeout,
    console,
    document: { querySelector() { throw new Error('Unexpected login flow'); } },
    fetch,
    localStorage,
    setTimeout,
    window,
  };
  vm.runInNewContext(source, context);
  const sync = new window.DashboardSync({
    legacyKey: 'dashboard',
    normalize: (state) => structuredClone(state),
    makeDemo: () => sampleState('demo'),
    setState(state) { this.state = state; },
    onStatus(kind, message, pending) { statuses.push({ kind, message, pending }); },
    onLegacyData() {},
  });
  return {
    get pending() { return sync.pending; },
    get revision() { return revision; },
    get serverState() { return serverState; },
    get statuses() { return statuses; },
    get state() { return sync.state; },
    get storage() { return values; },
    setOnline(value) { online = value; },
    setServer(state, currentRevision) { serverState = state; revision = currentRevision; },
    sync,
  };
}

function sampleState(name) {
  return {
    settings: { title: name },
    students: [{ id: name, name }],
    classes: [],
    payments: {},
    milestones: [],
  };
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return body; },
  };
}

async function waitForSave(harness) {
  for (let attempt = 0; attempt < 20 && harness.pending; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('migrates browser data only into an empty shared database', async () => {
  const legacy = sampleState('legacy');
  const harness = createHarness({
    storage: { dashboard: JSON.stringify({ schemaVersion: 2, state: legacy }) },
  });
  const loaded = await harness.sync.load();
  assert.equal(loaded.settings.title, 'legacy');
  await waitForSave(harness);
  assert.equal(harness.serverState.settings.title, 'legacy');
  assert.equal(harness.revision, 1);

  const secondBrowser = createHarness({
    initialState: sampleState('shared'),
    initialRevision: 3,
    storage: { dashboard: JSON.stringify({ schemaVersion: 2, state: legacy }) },
  });
  await secondBrowser.sync.load();
  assert.equal(secondBrowser.state.settings.title, 'shared');
  assert.equal(secondBrowser.serverState.settings.title, 'shared');
});

test('keeps offline edits in a durable outbox and refuses to overwrite a newer dataset', async () => {
  const original = sampleState('legacy');
  const harness = createHarness({
    storage: { dashboard: JSON.stringify({ schemaVersion: 2, state: original }) },
  });
  harness.setOnline(false);
  await harness.sync.load();
  const edited = sampleState('offline edit');
  harness.sync.save(edited);
  const pending = JSON.parse(harness.storage.get('dashboard_pending'));
  assert.equal(pending.state.settings.title, 'offline edit');
  assert.equal(pending.baseRevision, null);

  harness.setOnline(true);
  harness.setServer(sampleState('newer shared data'), 1);
  harness.sync.retry();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.serverState.settings.title, 'newer shared data');
  assert.equal(harness.pending.state.settings.title, 'offline edit');
  assert.equal(harness.statuses.at(-1).kind, 'conflict');
});

test('restores and syncs an offline outbox after reopening when the shared database is still empty', async () => {
  const pending = sampleState('recovered offline edit');
  const harness = createHarness({
    storage: {
      dashboard_pending: JSON.stringify({
        version: 1,
        baseRevision: null,
        state: pending,
      }),
    },
  });
  const loaded = await harness.sync.load();
  await waitForSave(harness);
  assert.equal(loaded.settings.title, 'recovered offline edit');
  assert.equal(harness.serverState.settings.title, 'recovered offline edit');
  assert.equal(harness.revision, 1);
  assert.equal(harness.storage.has('dashboard_pending'), false);
});

test('preserves the pending snapshot when another browser advances the revision', async () => {
  const harness = createHarness({ initialState: sampleState('shared'), initialRevision: 1 });
  await harness.sync.load();
  harness.setServer(sampleState('other browser update'), 2);
  harness.sync.save(sampleState('local change'));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const { state: pendingState, baseRevision } = harness.pending;
  assert.equal(pendingState.settings.title, 'local change');
  assert.equal(baseRevision, 1);
  assert.equal(harness.serverState.settings.title, 'other browser update');
  assert.equal(harness.statuses.at(-1).kind, 'conflict');
});
