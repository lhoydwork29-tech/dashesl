const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const COOKIE_NAME = 'dashboard_session';
const SESSION_AGE_SECONDS = 60 * 60 * 24 * 7;
const MAX_BODY_BYTES = 25 * 1024 * 1024;

function createServer(options = {}) {
  const dataDir = options.dataDir || process.env.DASHBOARD_DATA_DIR || path.join(ROOT, 'data');
  const privateDataDir = path.resolve(dataDir);
  const realRoot = fs.realpathSync(ROOT);
  const password = options.password || process.env.DASHBOARD_PASSWORD;
  if (typeof password !== 'string' || password.length < 12) {
    throw new Error('Set DASHBOARD_PASSWORD to a value at least 12 characters long.');
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const realDataDir = fs.realpathSync(dataDir);
  const database = new DatabaseSync(path.join(dataDir, 'dashboard.sqlite'));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS dashboard_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data TEXT NOT NULL,
      revision INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const sessionSecret = options.sessionSecret || crypto.randomBytes(32);
  const readDashboard = database.prepare(
    'SELECT data, revision, updated_at FROM dashboard_state WHERE id = 1'
  );
  const writeDashboard = database.prepare(
    'INSERT INTO dashboard_state (id, data, revision, updated_at) VALUES (1, ?, 1, ?)'
  );
  const updateDashboard = database.prepare(
    'UPDATE dashboard_state SET data = ?, revision = ?, updated_at = ? WHERE id = 1'
  );

  function serializeDashboard(row) {
    return row
      ? { state: JSON.parse(row.data), revision: row.revision, updatedAt: row.updated_at }
      : { state: null, revision: 0, updatedAt: null };
  }

  function createSessionCookie(expiresAt) {
    const payload = String(expiresAt);
    const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  function hasValidSession(request) {
    const cookieHeader = request.headers.cookie || '';
    const token = cookieHeader
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE_NAME}=`))
      ?.slice(COOKIE_NAME.length + 1);
    if (!token) return false;

    const [payload, signature, extra] = token.split('.');
    const expiresAt = Number(payload);
    if (!payload || !signature || extra || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
      return false;
    }
    const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest();
    let actual;
    try {
      actual = Buffer.from(signature, 'base64url');
    } catch {
      return false;
    }
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  function sendJson(response, statusCode, body, headers = {}) {
    response.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    });
    response.end(JSON.stringify(body));
  }

  async function readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('Request body is too large.');
        error.statusCode = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      const error = new Error('Request body must be valid JSON.');
      error.statusCode = 400;
      throw error;
    }
  }

  function isDashboardState(value) {
    return value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && value.settings !== null
      && typeof value.settings === 'object'
      && !Array.isArray(value.settings)
      && Array.isArray(value.students)
      && Array.isArray(value.classes)
      && value.payments !== null
      && typeof value.payments === 'object'
      && !Array.isArray(value.payments);
  }

  function isCorrectPassword(candidate) {
    if (typeof candidate !== 'string') return false;
    const actual = crypto.createHash('sha256').update(candidate).digest();
    const expected = crypto.createHash('sha256').update(password).digest();
    return crypto.timingSafeEqual(actual, expected);
  }

  async function handleApi(request, response, url) {
    if (url.pathname === '/api/session') {
      if (request.method === 'GET') {
        return sendJson(response, 200, { authenticated: hasValidSession(request) });
      }
      if (request.method !== 'POST') {
        return sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
      }
      const body = await readJson(request);
      if (!isCorrectPassword(body?.password)) {
        return sendJson(response, 401, { error: 'The dashboard password is incorrect.' });
      }
      const secure = request.socket.encrypted || request.headers['x-forwarded-proto'] === 'https';
      const cookie = `${COOKIE_NAME}=${createSessionCookie(Date.now() + SESSION_AGE_SECONDS * 1000)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_AGE_SECONDS}${secure ? '; Secure' : ''}`;
      return sendJson(response, 200, { authenticated: true }, { 'Set-Cookie': cookie });
    }

    if (url.pathname !== '/api/dashboard') {
      return sendJson(response, 404, { error: 'API route not found.' });
    }
    if (!hasValidSession(request)) {
      return sendJson(response, 401, { error: 'Sign in to access this dashboard.' });
    }
    if (request.method === 'GET') {
      return sendJson(response, 200, serializeDashboard(readDashboard.get()));
    }
    if (request.method !== 'PUT') {
      return sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, PUT' });
    }

    const body = await readJson(request);
    if (!isDashboardState(body?.state)) {
      return sendJson(response, 400, {
        error: 'Dashboard data must include settings, students, classes, and payments.',
      });
    }
    if (!Number.isSafeInteger(body.revision) || body.revision < 0) {
      return sendJson(response, 400, { error: 'A valid dashboard revision is required.' });
    }

    database.exec('BEGIN IMMEDIATE');
    try {
      const current = readDashboard.get();
      const revision = current?.revision || 0;
      if (revision !== body.revision) {
        database.exec('ROLLBACK');
        return sendJson(response, 409, {
          error: 'The shared dashboard changed in another browser. Your changes were not overwritten.',
          ...serializeDashboard(current),
        });
      }
      const updatedAt = new Date().toISOString();
      const serializedState = JSON.stringify(body.state);
      if (current) {
        updateDashboard.run(serializedState, revision + 1, updatedAt);
      } else {
        writeDashboard.run(serializedState, updatedAt);
      }
      database.exec('COMMIT');
      return sendJson(response, current ? 200 : 201, {
        state: body.state,
        revision: revision + 1,
        updatedAt,
      });
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  const mimeTypes = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        await handleApi(request, response, url);
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        response.end();
        return;
      }

      let pathname;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
      if (relativePath.split('/').some((segment) => segment.startsWith('.'))) {
        response.writeHead(404);
        response.end();
        return;
      }
      const filePath = path.resolve(ROOT, relativePath);
      const isWithin = (directory, target) => target === directory || target.startsWith(`${directory}${path.sep}`);
      if (!isWithin(ROOT, filePath) || isWithin(privateDataDir, filePath)) {
        response.writeHead(403);
        response.end();
        return;
      }
      let file;
      try {
        const realFilePath = await fs.promises.realpath(filePath);
        if (!isWithin(realRoot, realFilePath)
          || isWithin(privateDataDir, realFilePath)
          || isWithin(realDataDir, realFilePath)) {
          response.writeHead(403);
          response.end();
          return;
        }
        file = await fs.promises.readFile(realFilePath);
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'EISDIR') {
          response.writeHead(404);
          response.end('Not found');
          return;
        }
        throw error;
      }
      response.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : file);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error.statusCode) {
        sendJson(response, error.statusCode, { error: error.message });
        return;
      }
      console.error('Dashboard request failed:', error);
      sendJson(response, 500, { error: 'The dashboard request could not be completed.' });
    }
  });

  server.on('close', () => database.close());
  return server;
}

if (require.main === module) {
  let server;
  try {
    server = createServer();
    const port = Number(process.env.PORT) || 3000;
    const host = process.env.HOST || '0.0.0.0';
    server.listen(port, host, () => {
      console.log(`Dashboard listening on http://${host}:${port}`);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { createServer };
