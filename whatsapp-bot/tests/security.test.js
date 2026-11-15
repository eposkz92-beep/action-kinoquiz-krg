/**
 * tests/security.test.js
 * Unit Test Suite for Server Security & Authentication Module
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecurityManager, getClientIp } from '../src/security.js';

test('Security & Authentication Module Test Suite', async (t) => {
  const security = createSecurityManager({
    adminUser: 'testadmin',
    adminPassword: 'secretpassword123',
    apiSecret: 'secrettoken456',
    maxFailedAttempts: 3,
    lockoutDurationMs: 1000
  });

  await t.test('1. Public path detection distinguishes public vs sensitive assets', () => {
    assert.equal(security.isPublicPath('/icon.svg'), true);
    assert.equal(security.isPublicPath('/avatar.png'), true);
    assert.equal(security.isPublicPath('/logo.png'), true);
    assert.equal(security.isPublicPath('/manifest.json'), true);
    assert.equal(security.isPublicPath('/api/health'), true);
    assert.equal(security.isPublicPath('/api/public/book'), true);

    // Protected paths
    assert.equal(security.isPublicPath('/'), false);
    assert.equal(security.isPublicPath('/qr'), false);
    assert.equal(security.isPublicPath('/api/status'), false);
    assert.equal(security.isPublicPath('/api/export/excel'), false);
    assert.equal(security.isPublicPath('/api/export/csv'), false);
    assert.equal(security.isPublicPath('/api/sync-games'), false);
    assert.equal(security.isPublicPath('/api/restart-server'), false);
    assert.equal(security.isPublicPath('/api/broadcast/send'), false);
  });

  await t.test('2. Basic Auth validation with valid and invalid credentials', () => {
    const validCreds = Buffer.from('testadmin:secretpassword123').toString('base64');
    const validReq = {
      url: '/api/status',
      headers: { authorization: `Basic ${validCreds}` }
    };
    assert.equal(security.authenticateRequest(validReq), true);

    const invalidCreds = Buffer.from('testadmin:wrongpassword').toString('base64');
    const invalidReq = {
      url: '/api/status',
      headers: { authorization: `Basic ${invalidCreds}` }
    };
    assert.equal(security.authenticateRequest(invalidReq), false);

    const emptyReq = { url: '/api/status', headers: {} };
    assert.equal(security.authenticateRequest(emptyReq), false);
  });

  await t.test('3. Bearer token authentication', () => {
    const validReq = {
      url: '/api/sync-games',
      headers: { authorization: 'Bearer secrettoken456' }
    };
    assert.equal(security.authenticateRequest(validReq), true);

    const invalidReq = {
      url: '/api/sync-games',
      headers: { authorization: 'Bearer badtoken' }
    };
    assert.equal(security.authenticateRequest(invalidReq), false);
  });

  await t.test('4. Query parameter token authentication (?token=... or ?key=...)', () => {
    const validQueryReq = {
      url: '/api/sync-games?token=secrettoken456',
      headers: {}
    };
    assert.equal(security.authenticateRequest(validQueryReq), true);

    const validKeyReq = {
      url: '/api/export/excel?key=secrettoken456',
      headers: {}
    };
    assert.equal(security.authenticateRequest(validKeyReq), true);

    const invalidQueryReq = {
      url: '/api/sync-games?token=wrong',
      headers: {}
    };
    assert.equal(security.authenticateRequest(invalidQueryReq), false);
  });

  await t.test('5. Rate-limiting & brute force lockout after max failed attempts', () => {
    const testIp = '198.51.100.42';
    assert.equal(security.isBlocked(testIp), false);

    security.recordFailure(testIp);
    assert.equal(security.isBlocked(testIp), false);

    security.recordFailure(testIp);
    assert.equal(security.isBlocked(testIp), false);

    // 3rd failure reaches maxFailedAttempts
    security.recordFailure(testIp);
    assert.equal(security.isBlocked(testIp), true);

    // Successful login clears block
    security.recordSuccess(testIp);
    assert.equal(security.isBlocked(testIp), false);
  });

  await t.test('6. getClientIp extracts forwarded IP or fallback socket', () => {
    const reqWithForwarded = {
      headers: { 'x-forwarded-for': '203.0.113.195, 10.0.0.1' },
      socket: { remoteAddress: '10.0.0.1' }
    };
    assert.equal(getClientIp(reqWithForwarded), '203.0.113.195');

    const reqDirect = {
      headers: {},
      socket: { remoteAddress: '192.168.1.100' }
    };
    assert.equal(getClientIp(reqDirect), '192.168.1.100');

    const reqEmpty = { headers: {} };
    assert.equal(getClientIp(reqEmpty), '127.0.0.1');
  });
});
