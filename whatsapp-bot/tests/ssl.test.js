import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAcmeChallenge, acmeChallengeStore, isCertValid } from '../src/ssl.js';

test('SSL / ACME Module Test Suite', async (t) => {
  await t.test('1. handleAcmeChallenge returns false for non-challenge routes', () => {
    let handled = false;
    const req = { url: '/api/health' };
    const res = {};
    handled = handleAcmeChallenge(req, res);
    assert.strictEqual(handled, false);
  });

  await t.test('2. handleAcmeChallenge returns 404 for unknown challenge token', () => {
    let statusCode = 0;
    let endedBody = '';
    const req = { url: '/.well-known/acme-challenge/unknown-token-123' };
    const res = {
      writeHead(code) { statusCode = code; },
      end(body) { endedBody = body; }
    };
    const handled = handleAcmeChallenge(req, res);
    assert.strictEqual(handled, true);
    assert.strictEqual(statusCode, 404);
  });

  await t.test('3. handleAcmeChallenge serves keyAuthorization for registered token', () => {
    acmeChallengeStore.set('valid-token-xyz', 'valid-token-xyz.secretKeyAuth');
    let statusCode = 0;
    let headers = {};
    let endedBody = '';
    const req = { url: '/.well-known/acme-challenge/valid-token-xyz' };
    const res = {
      writeHead(code, h) { statusCode = code; headers = h; },
      end(body) { endedBody = body; }
    };
    const handled = handleAcmeChallenge(req, res);
    assert.strictEqual(handled, true);
    assert.strictEqual(statusCode, 200);
    assert.strictEqual(endedBody, 'valid-token-xyz.secretKeyAuth');
    assert.strictEqual(headers['Content-Type'], 'text/plain');
    acmeChallengeStore.delete('valid-token-xyz');
  });

  await t.test('4. isCertValid handles malformed or invalid PEM certificates gracefully', () => {
    assert.strictEqual(isCertValid('not a pem cert'), false);
    assert.strictEqual(isCertValid(''), false);
    assert.strictEqual(isCertValid(null), false);
  });
});
