import { randomUUID, timingSafeEqual } from 'node:crypto';

/** Attach JSON responses, request IDs, safe headers, and completion audit logging. */
export function requestContext(logger) {
  return function context(req, res, next) {
    const requestId = randomUUID();
    res.set({ 'X-Request-ID': requestId, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    // Central response helper keeps the same envelope across all routers.
    res.reply = (status, data) => res.status(status).json({ ...data, requestId });
    res.on('finish', () => logger(JSON.stringify({ time: new Date().toISOString(), requestId,
      method: req.method, path: req.path, status: res.statusCode })));
    // No endpoints consume bodies yet; drain them for HTTP connection reuse.
    req.resume();
    next();
  };
}

/** Permit exact configured browser origins; authentication is a separate layer. */
export function cors(origins) {
  return function checkOrigin(req, res, next) {
    const origin = req.headers.origin;
    if (origin && !origins.includes(origin)) return res.reply(403, { error: 'Origin not allowed' });
    if (origin) res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
    if (req.method === 'OPTIONS') {
      res.set({ 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' });
      return res.status(204).end();
    }
    next();
  };
}

/** Require the management bearer secret, comparing equal-length buffers safely. */
export function authenticate(token) {
  const expected = Buffer.from(`Bearer ${token}`);
  return function checkToken(req, res, next) {
    const actual = Buffer.from(req.headers.authorization || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return res.reply(401, { error: 'Unauthorized' });
    next();
  };
}

/** Shared fixed-minute budget per API instance; never trust forwarded client IPs. */
export function rateLimit() {
  let minute = -1, count = 0;
  return function checkBudget(req, res, next) {
    const current = Math.floor(Date.now() / 60000);
    if (minute !== current) { minute = current; count = 0; }
    if (++count > 120) { res.set('Retry-After', '60'); return res.reply(429, { error: 'Rate limit exceeded' }); }
    next();
  };
}

/** Final Express error handler: hide backend details and never expose stack traces. */
export function backendError(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error.status === 409) {
  return res.reply(409, { error: error.message });
}
  return res.reply(502, { error: 'Backend unavailable or request failed' });
}
