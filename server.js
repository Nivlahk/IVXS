// kh-test-server.js — KH Backend Test Server
// A minimal Node.js HTTP server to develop against while building the KH runtime integration.
// Run with: node server.js
// No dependencies — uses only Node built-ins.
// The server sets permissive CORS headers so the KH editor (any origin) can reach it.

'use strict';

const http = require('http');
const PORT = 3001;

// ── Simple in-memory data store ───────────────────────────────────────────────
const db = {
  users: [
    { id: 1, name: 'Alice', role: 'admin',  active: true  },
    { id: 2, name: 'Bob',   role: 'viewer', active: true  },
    { id: 3, name: 'Carol', role: 'viewer', active: false },
  ],
  messages: [],
};

// ── Routing table ─────────────────────────────────────────────────────────────
// Each entry: { method, path (string or RegExp), handler(req, body, match) → data }
const routes = [

  // Health check
  {
    method: 'GET', path: '/health',
    handler: () => ({ ok: true, time: new Date().toISOString(), version: '1.0.0' }),
  },

  // List all users, or filter by ?active=true/false
  {
    method: 'GET', path: '/users',
    handler: (req) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const activeFilter = url.searchParams.get('active');
      let users = db.users;
      if (activeFilter === 'true')  users = users.filter(u => u.active);
      if (activeFilter === 'false') users = users.filter(u => !u.active);
      return { users, total: users.length };
    },
  },

  // Get one user by ID
  {
    method: 'GET', path: /^\/users\/(\d+)$/,
    handler: (req, _body, match) => {
      const user = db.users.find(u => u.id === Number(match[1]));
      if (!user) return { error: 'User not found', status: 404 };
      return { user };
    },
  },

  // Create a user
  {
    method: 'POST', path: '/users',
    handler: (_req, body) => {
      if (!body?.name) return { error: 'name is required', status: 400 };
      const user = {
        id: Math.max(0, ...db.users.map(u => u.id)) + 1,
        name: String(body.name),
        role: body.role ?? 'viewer',
        active: body.active ?? true,
      };
      db.users.push(user);
      return { user, created: true };
    },
  },

  // Echo endpoint — returns exactly what you POST to it
  {
    method: 'POST', path: '/echo',
    handler: (_req, body) => ({ echo: body, receivedAt: new Date().toISOString() }),
  },

  // Send a message (stored in memory)
  {
    method: 'POST', path: '/messages',
    handler: (_req, body) => {
      if (!body?.text) return { error: 'text is required', status: 400 };
      const msg = {
        id: db.messages.length + 1,
        text: String(body.text),
        from: body.from ?? 'anonymous',
        at: new Date().toISOString(),
      };
      db.messages.push(msg);
      return { message: msg, stored: true };
    },
  },

  // List all messages
  {
    method: 'GET', path: '/messages',
    handler: () => ({ messages: db.messages, total: db.messages.length }),
  },

];

// ── CORS headers — allow requests from any origin (dev only) ──────────────────
function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
}

// ── Auth check — reads from ?key= or Authorization/x-api-key headers ──────────
// Set API_KEY env var when starting: API_KEY=secret123 node server.js
// If API_KEY is not set, auth is disabled (open server).
const API_KEY = process.env.API_KEY ?? null;

function checkAuth(req) {
  if (!API_KEY) return true; // No key configured — open access
  const authHeader = req.headers['authorization'] ?? '';
  const apiKeyHeader = req.headers['x-api-key'] ?? '';
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const queryKey = url.searchParams.get('key') ?? '';

  if (authHeader === `Bearer ${API_KEY}`) return true;
  if (apiKeyHeader === API_KEY)            return true;
  if (queryKey === API_KEY)                return true;
  return false;
}

// ── Request handler ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  setCORS(res);

  // Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Auth
  if (!checkAuth(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized — check your API key' }));
    return;
  }

  // Read body
  let body = null;
  if (req.method === 'POST' || req.method === 'PUT') {
    body = await new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', chunk => raw += chunk);
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({}); // Non-JSON body — treat as empty
        }
      });
      req.on('error', reject);
    });
  }

  // Match route
  const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
  let matched = null;
  let match = null;

  for (const route of routes) {
    if (route.method !== req.method) continue;
    if (typeof route.path === 'string') {
      if (route.path === pathname) { matched = route; match = [pathname]; break; }
    } else {
      const m = pathname.match(route.path);
      if (m) { matched = route; match = m; break; }
    }
  }

  if (!matched) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `No route for ${req.method} ${pathname}` }));
    return;
  }

  // Run handler
  try {
    const result = await matched.handler(req, body, match);
    const status = result?.status ?? 200;
    const payload = result?.status ? (() => { const r = { ...result }; delete r.status; return r; })() : result;

    // Log to console
    const tag = status >= 400 ? '✗' : '✓';
    console.log(`${tag}  ${req.method.padEnd(6)} ${pathname}  →  ${status}`);
    if (body && Object.keys(body).length > 0) console.log('   body:', JSON.stringify(body));

    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  } catch (e) {
    console.error('Handler error:', e);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error', detail: e.message }));
  }
});

server.listen(PORT, () => {
  const keyMsg = API_KEY ? `API key protection ON (key: ${API_KEY})` : 'No auth — open access';
  console.log(`\nKH Test Server running → http://localhost:${PORT}`);
  console.log(`${keyMsg}\n`);
  console.log('Available endpoints:');
  for (const r of routes) {
    const p = typeof r.path === 'string' ? r.path : r.path.toString();
    console.log(`  ${r.method.padEnd(6)} ${p}`);
  }
  console.log('\nTo protect with a key:  API_KEY=mysecret node server.js');
  console.log('Then add "my-server" in KH Credentials with value "mysecret"\n');
});
