/**
 * src/security.js
 * Security middleware, authentication, and brute-force protection for Kinoquiz Admin Web Server.
 */

/**
 * Extracts client IP from request headers or socket.
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
export function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return String(forwarded).split(',')[0].trim();
  }
  return req.socket?.remoteAddress || '127.0.0.1';
}

/**
 * Creates security manager for admin HTTP server.
 *
 * @param {Object} options
 * @param {string} [options.adminUser='admin'] - Admin username
 * @param {string} [options.adminPassword='kinoquiz2026'] - Admin password
 * @param {string} [options.apiSecret='kinoquiz2026'] - API token for scripts/webhooks
 * @param {number} [options.maxFailedAttempts=5] - Maximum failed auth attempts before lock
 * @param {number} [options.lockoutDurationMs=900000] - Lockout duration (default 15 minutes)
 * @returns {Object} Security manager instance
 */
export function createSecurityManager({
  adminUser = 'admin',
  adminPassword = 'kinoquiz2026',
  apiSecret = 'kinoquiz2026',
  maxFailedAttempts = 5,
  lockoutDurationMs = 15 * 60 * 1000
} = {}) {
  const failedAttempts = new Map();

  /**
   * Checks if an IP is currently locked out due to brute-force attempts.
   * @param {string} ip
   * @returns {boolean}
   */
  function isBlocked(ip) {
    const record = failedAttempts.get(ip);
    if (!record) return false;
    if (record.lockUntil && Date.now() < record.lockUntil) {
      return true;
    }
    if (record.lockUntil && Date.now() >= record.lockUntil) {
      failedAttempts.delete(ip);
      return false;
    }
    return false;
  }

  /**
   * Records a failed authentication attempt.
   * @param {string} ip
   */
  function recordFailure(ip) {
    const now = Date.now();
    const record = failedAttempts.get(ip) || { count: 0, firstAttempt: now, lockUntil: 0 };
    record.count += 1;
    if (record.count >= maxFailedAttempts) {
      record.lockUntil = now + lockoutDurationMs;
    }
    failedAttempts.set(ip, record);
  }

  /**
   * Clears failed attempt tracking upon successful authentication.
   * @param {string} ip
   */
  function recordSuccess(ip) {
    failedAttempts.delete(ip);
  }

  /**
   * Checks if requested path is public (static assets, health check).
   * @param {string} pathname
   * @returns {boolean}
   */
  function isPublicPath(pathname) {
    if (
      pathname === '/icon.svg' ||
      pathname === '/avatar.png' ||
      pathname === '/logo.png' ||
      pathname === '/manifest.json' ||
      pathname === '/api/health' ||
      pathname === '/api/public/book' ||
      pathname.startsWith('/.well-known/acme-challenge/')
    ) {
      return true;
    }
    return false;
  }

  /**
   * Verifies credentials from Basic Auth, Bearer token, or query parameters.
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean}
   */
  function authenticateRequest(req) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // 1. Check query parameter token
    const token = url.searchParams.get('token') || url.searchParams.get('key');
    if (token && (token === apiSecret || token === adminPassword)) {
      return true;
    }

    // 2. Check Authorization header
    const authHeader = req.headers['authorization'] || '';
    if (authHeader.startsWith('Bearer ')) {
      const bToken = authHeader.slice(7).trim();
      if (bToken === apiSecret || bToken === adminPassword) {
        return true;
      }
    }

    if (authHeader.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(authHeader.slice(6).trim(), 'base64').toString('utf8');
        const [u, ...pParts] = decoded.split(':');
        const p = pParts.join(':');
        if (u === adminUser && p === adminPassword) {
          return true;
        }
      } catch (e) {}
    }

    return false;
  }

  /**
   * Sends 401 Unauthorized response with WWW-Authenticate header.
   * @param {import('node:http').ServerResponse} res
   */
  function sendUnauthorized(res) {
    res.writeHead(401, {
      'Content-Type': 'text/html; charset=utf-8',
      'WWW-Authenticate': 'Basic realm="ACTION Kinoquiz Admin Area"',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY'
    });
    res.end(`<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>401 Unauthorized | ACTION Киноквиз</title>
  <style>
    body {
      background: #0b0914;
      color: #f3f4f6;
      font-family: system-ui, -apple-system, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 16px;
      box-sizing: border-box;
    }
    .card {
      background: #131127;
      border: 1px solid #2e2850;
      border-radius: 16px;
      padding: 32px 24px;
      text-align: center;
      max-width: 420px;
      width: 100%;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    }
    h2 { color: #ef4444; margin-top: 0; font-size: 22px; }
    p { color: #9ca3af; font-size: 14px; line-height: 1.5; margin: 12px 0 20px; }
    .badge {
      display: inline-block;
      background: rgba(239, 68, 68, 0.15);
      color: #f87171;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 16px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">🔒 Доступ ограничен</div>
    <h2>Требуется авторизация</h2>
    <p>Панель управления и данные участников защищены паролем. Пожалуйста, введите логин и пароль администратора в окне входа вашего браузера.</p>
  </div>
</body>
</html>`);
  }

  /**
   * Sends 429 Too Many Requests response for locked IPs.
   * @param {import('node:http').ServerResponse} res
   */
  function sendRateLimited(res) {
    res.writeHead(429, {
      'Content-Type': 'application/json; charset=utf-8',
      'Retry-After': '900',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(JSON.stringify({
      ok: false,
      error: 'Слишком много неудачных попыток входа. Доступ временно заблокирован на 15 минут.'
    }));
  }

  return {
    isBlocked,
    recordFailure,
    recordSuccess,
    isPublicPath,
    authenticateRequest,
    sendUnauthorized,
    sendRateLimited
  };
}
