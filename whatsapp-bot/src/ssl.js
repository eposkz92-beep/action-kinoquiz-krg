/**
 * whatsapp-bot/src/ssl.js
 * Automatic SSL / HTTPS provisioning and management for Kinoquiz Web Server.
 * Uses Let's Encrypt via ACME HTTP-01 challenge with fail-safe degradation.
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';

// In-memory challenge store for HTTP-01 validations
export const acmeChallengeStore = new Map();

/**
 * Handles incoming ACME HTTP-01 challenge requests on port 80.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {boolean} True if handled
 */
export function handleAcmeChallenge(req, res) {
  const url = req.url || '';
  if (url.startsWith('/.well-known/acme-challenge/')) {
    const token = url.replace('/.well-known/acme-challenge/', '').split('?')[0];
    const keyAuth = acmeChallengeStore.get(token);
    if (keyAuth) {
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      });
      res.end(keyAuth);
      return true;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('ACME challenge token not found or expired');
    return true;
  }
  return false;
}

/**
 * Checks whether an existing PEM certificate is valid for at least minDaysRemaining.
 * @param {string} certPem
 * @param {number} minDaysRemaining
 * @returns {boolean}
 */
export function isCertValid(certPem, minDaysRemaining = 14) {
  try {
    const x509 = new crypto.X509Certificate(certPem);
    const validTo = new Date(x509.validTo);
    const msRemaining = validTo.getTime() - Date.now();
    const daysRemaining = msRemaining / (1000 * 60 * 60 * 24);
    return daysRemaining >= minDaysRemaining;
  } catch (e) {
    return false;
  }
}

/**
 * Initializes and starts HTTPS server on port 443 with Let's Encrypt certificate.
 * Gracefully degrades if port 443 is unbindable or ACME is temporarily unavailable.
 *
 * @param {Object} options
 * @param {Function} options.requestHandler - HTTP request handler function
 * @param {Object} options.logger - Pino logger instance
 * @param {Object} options.config - Bot configuration
 * @param {string} [options.dataDir] - Data directory path for SSL cert storage
 * @returns {Promise<import('node:https').Server|null>}
 */
export async function startHttpsServer({ requestHandler, logger, config, dataDir }) {
  const sslDir = path.resolve(dataDir || path.join(process.cwd(), 'data'), 'ssl');
  const certPath = path.join(sslDir, 'cert.pem');
  const keyPath = path.join(sslDir, 'key.pem');
  const domain = config.sslDomain || '136-71-1-182.sslip.io';
  const httpsPort = config.httpsPort || 443;

  if (!fs.existsSync(sslDir)) {
    try {
      fs.mkdirSync(sslDir, { recursive: true });
    } catch (e) {
      logger.warn({ err: e.message }, 'Failed to create SSL directory');
    }
  }

  let certPem = null;
  let keyPem = null;

  // 1. Try loading existing certificate from disk
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const existingCert = fs.readFileSync(certPath, 'utf8');
      const existingKey = fs.readFileSync(keyPath, 'utf8');
      if (isCertValid(existingCert, 14)) {
        certPem = existingCert;
        keyPem = existingKey;
        logger.info({ domain, certPath }, 'Existing SSL certificate loaded from disk and is valid');
      } else {
        logger.info({ domain }, 'Existing SSL certificate is expiring or invalid. Attempting renewal...');
      }
    } catch (loadErr) {
      logger.warn({ loadErr: loadErr.message }, 'Failed reading cached SSL files from disk');
    }
  }

  // 2. If no valid certificate, obtain one using acme-client
  if (!certPem || !keyPem) {
    let acme = null;
    try {
      acme = await import('acme-client');
    } catch (impErr) {
      logger.warn('acme-client module not installed yet. Skipping automated SSL issuance for now.');
      return null;
    }

    try {
      logger.info({ domain }, 'Requesting new Let\'s Encrypt SSL certificate via ACME HTTP-01 challenge...');
      const client = new acme.Client({
        directoryUrl: acme.directory.letsencrypt.production,
        accountKey: await acme.crypto.createPrivateKey()
      });

      const [certKey, csr] = await acme.crypto.createCsr({
        commonName: domain
      });

      const cert = await client.auto({
        csr,
        email: config.adminEmail || 'admin@action-kinoquiz.kz',
        termsOfServiceAgreed: true,
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
          logger.info({ token: challenge.token }, 'ACME challenge registered in memory');
          acmeChallengeStore.set(challenge.token, keyAuthorization);
        },
        challengeRemoveFn: async (authz, challenge) => {
          acmeChallengeStore.delete(challenge.token);
        }
      });

      certPem = cert.toString();
      keyPem = certKey.toString();

      fs.writeFileSync(certPath, certPem, 'utf8');
      fs.writeFileSync(keyPath, keyPem, 'utf8');
      logger.info({ domain, certPath }, '✅ SSL certificate successfully obtained and saved to disk');
    } catch (acmeErr) {
      logger.warn({ acmeErr: acmeErr.message, domain }, 'Failed to obtain SSL certificate via ACME');
      return null;
    }
  }

  // 3. Start HTTPS Server
  try {
    const httpsServer = https.createServer({
      cert: certPem,
      key: keyPem
    }, requestHandler);

    httpsServer.on('error', (srvErr) => {
      logger.warn({ srvErr: srvErr.message, port: httpsPort }, 'HTTPS server encountered an error (HTTP server continues on port 80)');
    });

    await new Promise((resolve) => {
      httpsServer.listen(httpsPort, '0.0.0.0', () => {
        logger.info(`🔒 HTTPS Server running at https://${domain}:${httpsPort} (SSL ACTIVE)`);
        resolve(httpsServer);
      });
    });

    return httpsServer;
  } catch (listenErr) {
    logger.warn({ listenErr: listenErr.message, port: httpsPort }, 'Failed to bind HTTPS port 443 (HTTP remains fully operational)');
    return null;
  }
}
