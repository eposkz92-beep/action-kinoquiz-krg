/**
 * tests/helpers/testEnv.js
 * Hermetic Test Environment Isolation for ACTION Kinoquiz Bot Testing
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { initDatabase } from '../../src/db/database.js';
import { createMockCatalog } from './mockCatalog.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Module-level active environments registry and root environment snapshot
 * Ensures pristine process.env restoration and eliminates leaks under concurrent/interleaved execution.
 */
export const activeEnvs = new Set();
let rootEnvSnapshot = null;

/**
 * Creates an isolated test environment with SQLite database, mock catalog, and env config.
 * @param {Object} [options]
 * @param {boolean} [options.inMemory=true] - Whether to use :memory: database or temp disk directory
 * @param {Object} [options.catalog] - Options or preset for mock catalog generator
 * @param {Object} [options.env] - Additional process.env overrides
 * @returns {Promise<Object>} Test environment controller with cleanup()
 */
export async function createTestEnv(options = {}) {
  // Capture pristine root snapshot only when the very first active environment is opened
  if (activeEnvs.size === 0) {
    rootEnvSnapshot = { ...process.env };
  }

  const inMemory = options.inMemory !== false;
  let tempDir = null;
  let dbPath = ':memory:';

  if (!inMemory) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-kinoquiz-test-'));
    dbPath = path.join(tempDir, 'kinoquiz_test.sqlite');
  }

  // 1. Initialize SQLite Database via DAO initDatabase
  const dbClient = initDatabase(dbPath);
  const { db, teams, bookings, contacts, broadcastLogs, sessions } = dbClient;

  // 2. Prepare mock catalog
  let mockCatalogPath = null;
  if (tempDir) {
    mockCatalogPath = path.join(tempDir, 'instagram_state.json');
    const catalogGen = createMockCatalog(options.catalog || { preset: 'default' });
    catalogGen.writeTo(mockCatalogPath);
  } else {
    // Reference static fixture if inMemory
    mockCatalogPath = path.resolve(__dirname, '../fixtures/instagram_state.json');
  }

  const parentDir = tempDir || path.resolve(__dirname, '../fixtures');

  // 3. Environment Variable Isolation
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = dbPath;
  process.env.TELEGRAM_BOT_TOKEN = options.env?.TELEGRAM_BOT_TOKEN || 'mock_telegram_bot_token_123';
  process.env.TELEGRAM_CHAT_ID = options.env?.TELEGRAM_CHAT_ID || '-1001234567890';
  process.env.INSTAGRAM_STATE_PATH = mockCatalogPath;
  process.env.PARENT_DIR = parentDir;

  if (options.env) {
    for (const [key, val] of Object.entries(options.env)) {
      process.env[key] = String(val);
    }
  }

  // Safe Windows Cleanup
  let isCleanedUp = false;
  const envController = {
    db,
    dbPath,
    tempDir,
    parentDir,
    mockCatalogPath,
    customEnv: options.env ? { ...options.env } : null,
    teams,
    bookings,
    contacts,
    broadcastLogs,
    sessions,
    cleanup: async () => {
      if (isCleanedUp) return;
      isCleanedUp = true;

      // 1. Close database handle first to release Windows kernel file lock
      try {
        dbClient.close();
      } catch {
        // Ignore if already closed
      }

      // 2. Delete temporary directory on disk
      if (tempDir && fs.existsSync(tempDir)) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch {
          // Windows file locks may have a small release delay
          await new Promise(resolve => setTimeout(resolve, 50));
          try {
            fs.rmSync(tempDir, { recursive: true, force: true });
          } catch {
            // Ignore if still locked during test process shutdown
          }
        }
      }

      // 3. Unregister from active environments set
      activeEnvs.delete(envController);

      // 4. Restore environment state based on remaining active environments
      if (activeEnvs.size > 0) {
        // Interleaved/concurrent case: point to most recent remaining active environment
        const remaining = Array.from(activeEnvs);
        const top = remaining[remaining.length - 1];
        process.env.PARENT_DIR = top.parentDir;
        process.env.DB_PATH = top.dbPath;
        process.env.INSTAGRAM_STATE_PATH = top.mockCatalogPath;
        process.env.TELEGRAM_BOT_TOKEN = top.customEnv?.TELEGRAM_BOT_TOKEN || 'mock_telegram_bot_token_123';
        process.env.TELEGRAM_CHAT_ID = top.customEnv?.TELEGRAM_CHAT_ID || '-1001234567890';

        // Clean up any custom variables that this instance added and are not defined in remaining envs
        if (options.env) {
          for (const key of Object.keys(options.env)) {
            let restoredVal = undefined;
            for (let i = remaining.length - 1; i >= 0; i--) {
              if (remaining[i].customEnv && key in remaining[i].customEnv) {
                restoredVal = remaining[i].customEnv[key];
                break;
              }
            }
            if (restoredVal !== undefined) {
              process.env[key] = String(restoredVal);
            } else if (rootEnvSnapshot && key in rootEnvSnapshot) {
              process.env[key] = rootEnvSnapshot[key];
            } else {
              delete process.env[key];
            }
          }
        }
      } else {
        // All active environments are cleaned up: completely restore pristine root snapshot
        if (rootEnvSnapshot) {
          for (const key of Object.keys(process.env)) {
            if (!(key in rootEnvSnapshot)) {
              delete process.env[key];
            }
          }
          Object.assign(process.env, rootEnvSnapshot);
          rootEnvSnapshot = null;
        }
      }
    },

    /**
     * Helper to seed a booking directly into DB
     * @param {Object} bookingData
     * @returns {Object} Created booking record
     */
    seedBooking(bookingData) {
      return bookings.create({
        teamName: bookingData.teamName || 'Тестовая команда',
        captainName: bookingData.captainName || 'Капитан Тест',
        captainPhone: bookingData.captainPhone || '+77011863190',
        playersCount: bookingData.playersCount || 6,
        gameTitle: bookingData.gameTitle || 'Киномарафон: 100 вопросов',
        gameDate: bookingData.gameDate || '2026-11-24',
        source: bookingData.source || 'whatsapp',
        status: bookingData.status || 'confirmed',
        notes: bookingData.notes || ''
      });
    }
  };

  activeEnvs.add(envController);
  return envController;
}

export default createTestEnv;
