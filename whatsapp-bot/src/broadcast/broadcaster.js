/**
 * src/broadcast/broadcaster.js
 * Serialized FIFO Broadcast Queue Worker & Anti-Spam Protection for ACTION Kinoquiz Bot
 *
 * Implements:
 * - Serialized FIFO execution to prevent WhatsApp bans
 * - Anti-spam randomized jitter (3000ms - 7000ms) between successive messages
 * - Typing presence simulation (sock.sendPresenceUpdate('composing', jid)) with 1000-2000ms typing delay
 * - Dynamic message personalization ({{captain}}, {{team}}, {{game}}, {{time}}, {{date}}, etc.)
 * - Opt-out handling ("СТОП" / "STOP") updating contacts.is_subscribed = 0 and logging status='opted_out'
 * - Complete execution tracking in SQLite broadcast_logs (sent, failed, skipped_opted_out)
 * - Inversion of control: injectable sleepFn and typingDelayFn for fast hermetic unit tests
 */
import { normalizePhone } from '../db/database.js';

/**
 * Generates a randomized integer jitter delay within specified millisecond bounds.
 * Default: [3000, 7000] ms.
 *
 * @param {number} [min=3000] - Minimum delay in ms
 * @param {number} [max=7000] - Maximum delay in ms
 * @returns {number} Delay in milliseconds
 */
export function getRandomJitter(min = 3000, max = 7000) {
  const actualMin = Math.min(min, max);
  const actualMax = Math.max(min, max);
  return Math.floor(Math.random() * (actualMax - actualMin + 1)) + actualMin;
}

/**
 * Generates a randomized typing presence simulation delay.
 * Default: [1000, 2000] ms.
 *
 * @param {number} [min=1000] - Minimum typing duration in ms
 * @param {number} [max=2000] - Maximum typing duration in ms
 * @returns {number} Delay in milliseconds
 */
export function getRandomTypingDelay(min = 1000, max = 2000) {
  const actualMin = Math.min(min, max);
  const actualMax = Math.max(min, max);
  return Math.floor(Math.random() * (actualMax - actualMin + 1)) + actualMin;
}

/**
 * Converts a phone number string into a valid WhatsApp JID (digits@s.whatsapp.net).
 * Converts 11-digit numbers starting with Kazakh trunk prefix 8 to 7.
 *
 * @param {string|number} phone - Phone number
 * @returns {string} WhatsApp JID (e.g. '77011863190@s.whatsapp.net')
 */
export function phoneToJid(phone) {
  if (!phone) return '';
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('8') && digits.length === 11) {
    digits = '7' + digits.slice(1);
  }
  return digits ? `${digits}@s.whatsapp.net` : '';
}

/**
 * Substitutes template variables with recipient and event metadata.
 * Supported tokens: {{captain}}, {{team}}, {{game}}, {{date}}, {{time}}, {{price}}, {{location}}, {{players}}, {{phone}}.
 * Matching is case-insensitive (e.g. {{CAPTAIN}} and {{captain}} are equivalent).
 *
 * @param {string} template - Message template with {{token}} placeholders
 * @param {Object} [params={}] - Key-value replacements
 * @returns {string} Personalized message text
 */
export function personalizeMessage(template, params = {}) {
  if (typeof template !== 'string') return '';
  const lookup = {
    captain: params.captain || params.captainName || params.name || '',
    team: params.team || params.teamName || '',
    game: params.game || params.gameTitle || '',
    date: params.date || params.gameDate || params.dateStr || '',
    time: params.time || params.timeStr || '19:30',
    price: params.price || '3 000 ₸',
    location: params.location || 'Караоке-бар «То Место» (пр. Нуркена Абдирова, 5)',
    players: params.players || params.playersCount || '',
    phone: params.phone || params.captainPhone || '',
    ...params
  };

  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    if (key in lookup) return String(lookup[key]);
    const lowerKey = key.toLowerCase();
    for (const [k, v] of Object.entries(lookup)) {
      if (k.toLowerCase() === lowerKey) return String(v);
    }
    return match;
  });
}

/**
 * Looks up a contact in the database using flexible phone format matching.
 * Checks normPhone, '+' + canonical7, canonical7, and '8' + canonical7.slice(1),
 * ensuring contacts saved with '+7...', '8...', or '7...' are properly located.
 *
 * @param {Object} db - Database instance with db.contacts
 * @param {string|number} phone - Phone number to search
 * @returns {Object|null} Matching contact row or null
 */
export function findContactFlexible(db, phone) {
  if (!db?.contacts || !phone) return null;
  const normPhone = normalizePhone(phone);
  if (!normPhone) return null;

  // 1. Try direct lookup with normalizePhone first
  let contact = db.contacts.getByPhone(normPhone);
  if (contact) return contact;

  // 2. Extract digits only
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;

  let canonical7 = digits;
  if (digits.startsWith('8') && digits.length === 11) {
    canonical7 = '7' + digits.slice(1);
  } else if (digits.length === 10) {
    canonical7 = '7' + digits;
  }

  // 3. Check canonical variants
  const variants = [
    '+' + canonical7,
    canonical7,
    canonical7.startsWith('7') && canonical7.length === 11 ? '8' + canonical7.slice(1) : null
  ].filter(Boolean);

  for (const variant of variants) {
    contact = db.contacts.getByPhone(variant);
    if (contact) return contact;
  }

  return null;
}

/**
 * Checks whether an incoming message is an unsubscribe / opt-out request ("СТОП" / "STOP").
 *
 * @param {string} text - Incoming message text
 * @returns {boolean} True if text matches opt-out command
 */
export function isOptOutMessage(text) {
  if (typeof text !== 'string') return false;
  return /^(стоп|stop)$/i.test(text.trim());
}

/**
 * Checks whether an incoming message is a re-subscription request ("СТАРТ" / "START").
 *
 * @param {string} text - Incoming message text
 * @returns {boolean} True if text matches opt-in command
 */
export function isOptInMessage(text) {
  if (typeof text !== 'string') return false;
  return /^(старт|start)$/i.test(text.trim());
}

/**
 * Processes an opt-out command: updates contacts subscription in SQLite and logs event.
 *
 * @param {Object} options - { phone, text, db }
 * @returns {Object} { optedOut: boolean, phone: string, replyText: string }
 */
export function handleOptOut({ phone, text, db }) {
  const normPhone = normalizePhone(phone);
  const contact = findContactFlexible(db, phone);
  const targetPhone = contact?.phone || normPhone;

  if (db?.contacts) {
    db.contacts.setSubscription(targetPhone, 0);
    if (normPhone && normPhone !== targetPhone) {
      db.contacts.setSubscription(normPhone, 0);
    }
  }
  if (db?.broadcastLogs) {
    db.broadcastLogs.create({
      campaign: 'opt_out',
      recipientPhone: targetPhone,
      recipientName: contact?.name || null,
      message: text || 'СТОП',
      status: 'opted_out',
      error: null
    });
  }
  return {
    optedOut: true,
    phone: targetPhone,
    replyText: 'Вы успешно отписались от рассылок ACTION Киноквиз. Чтобы снова получать анонсы, напишите «СТАРТ».'
  };
}

/**
 * Processes a re-subscription command: sets contacts.is_subscribed = 1 in SQLite.
 *
 * @param {Object} options - { phone, text, db }
 * @returns {Object} { optedIn: boolean, phone: string, replyText: string }
 */
export function handleOptIn({ phone, text, db }) {
  const normPhone = normalizePhone(phone);
  const contact = findContactFlexible(db, phone);
  const targetPhone = contact?.phone || normPhone;

  if (db?.contacts) {
    db.contacts.setSubscription(targetPhone, 1);
    if (normPhone && normPhone !== targetPhone) {
      db.contacts.setSubscription(normPhone, 1);
    }
  }
  return {
    optedIn: true,
    phone: targetPhone,
    replyText: 'Вы снова подписаны на рассылки ACTION Киноквиз! Ждём вас на играх.'
  };
}

/**
 * Normalizes delay range configuration into { min, max } format.
 * Accepts { min, max } or [min, max] or default.
 *
 * @param {Object|Array} range - Delay bounds
 * @param {number} defaultMin - Default min
 * @param {number} defaultMax - Default max
 * @returns {{ min: number, max: number }}
 */
function normalizeDelayRange(range, defaultMin, defaultMax) {
  if (Array.isArray(range) && range.length >= 2) {
    return { min: Number(range[0]), max: Number(range[1]) };
  }
  if (range && typeof range === 'object') {
    return {
      min: Number(range.min !== undefined ? range.min : defaultMin),
      max: Number(range.max !== undefined ? range.max : defaultMax)
    };
  }
  return { min: defaultMin, max: defaultMax };
}

/**
 * Creates an autonomous serialized FIFO broadcaster instance with anti-spam rate limiting.
 *
 * @param {Object} [options={}] - Configuration options
 * @param {Object} [options.db] - SQLite database DAO instance
 * @param {Object} [options.sock] - Baileys WASocket instance
 * @param {Function} [options.senderFn] - Function (jid, content) => Promise
 * @param {Function} [options.presenceFn] - Function (presence, jid) => Promise
 * @param {Function} [options.sleepFn] - Injected sleep function for tests
 * @param {Function} [options.typingDelayFn] - Injected typing delay function for tests
 * @param {Object|Array} [options.delayRange] - Inter-message delay range { min, max } or [min, max]
 * @param {Object|Array} [options.typingDelayRange] - Typing presence delay range
 * @param {boolean} [options.simulatePresence=true] - Whether to send typing indicators
 * @param {Object} [options.logger] - Optional logger
 * @returns {Object} Broadcaster instance
 */
export function createBroadcaster(options = {}) {
  const {
    db,
    sock,
    senderFn = (sock ? sock.sendMessage.bind(sock) : null),
    presenceFn = (sock ? sock.sendPresenceUpdate.bind(sock) : null),
    sleepFn = ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    typingDelayFn = sleepFn,
    delayRange: rawDelayRange,
    typingDelayRange: rawTypingRange,
    simulatePresence = true,
    logger = null
  } = options;

  const delayRange = normalizeDelayRange(rawDelayRange, 3000, 7000);
  const typingDelayRange = normalizeDelayRange(rawTypingRange, 1000, 2000);

  let isRunning = false;
  const queue = [];
  let processedCount = 0;
  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let activeWorkerCount = 0;
  let drainResolvers = [];

  async function processQueue() {
    if (isRunning) return;
    isRunning = true;

    try {
      while (queue.length > 0) {
        activeWorkerCount = 1;
        const job = queue.shift();

        try {
          const normPhone = normalizePhone(job.phone);
          const jid = job.jid || phoneToJid(normPhone);

          // 1. Opt-out verification
          if (db?.contacts) {
            const contact = findContactFlexible(db, job.phone || normPhone);
            if (contact && contact.is_subscribed === 0) {
              skippedCount++;
              if (db.broadcastLogs) {
                db.broadcastLogs.create({
                  campaign: job.campaign || 'broadcast',
                  recipientPhone: contact.phone || normPhone,
                  recipientName: job.name || contact.name || null,
                  message: job.messageTemplate || '',
                  status: 'skipped_opted_out',
                  error: null
                });
              }
              continue;
            }
          }

          // 2. Message personalization
          const messageText = job.personalizedText || personalizeMessage(job.messageTemplate, {
            captain: job.name,
            team: job.team,
            phone: normPhone,
            ...job.params
          });

          // 3. Anti-spam typing presence simulation
          if (simulatePresence && presenceFn) {
            try {
              await presenceFn('composing', jid);
              const typingMs = getRandomTypingDelay(typingDelayRange.min, typingDelayRange.max);
              await typingDelayFn(typingMs);
            } catch (pErr) {
              if (logger?.warn) logger.warn({ err: pErr }, 'Presence update failed');
            }
          }

          // 4. Message dispatch
          let sendError = null;
          try {
            if (!senderFn) {
              throw new Error('No senderFn available in broadcaster');
            }
            await senderFn(jid, { text: messageText });
            sentCount++;
          } catch (err) {
            sendError = err;
            failedCount++;
            if (logger?.error) logger.error({ err, jid }, 'Failed to send broadcast message');
          }

          // 5. Database logging
          if (db?.broadcastLogs) {
            db.broadcastLogs.create({
              campaign: job.campaign || 'broadcast',
              recipientPhone: normPhone,
              recipientName: job.name || null,
              message: messageText,
              status: sendError ? 'failed' : 'sent',
              error: sendError ? (sendError.message || String(sendError)) : null
            });
          }
        } catch (jobErr) {
          failedCount++;
          if (logger?.error) logger.error({ err: jobErr }, 'Unexpected broadcast job error');
        } finally {
          processedCount++;
          activeWorkerCount = 0;
        }

        // 6. Anti-spam jitter delay between successive messages
        if (queue.length > 0) {
          const jitterMs = getRandomJitter(delayRange.min, delayRange.max);
          await sleepFn(jitterMs);
        }
      }
    } finally {
      isRunning = false;
      activeWorkerCount = 0;
      const resolvers = [...drainResolvers];
      drainResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  return {
    /**
     * Enqueues a list of recipient jobs to be broadcasted in serialized FIFO order.
     *
     * @param {Object} payload - { recipients, messageTemplate, campaign, params }
     * @returns {Promise<{ batchId: string, queuedCount: number }>}
     */
    async enqueue({ recipients = [], messageTemplate = '', campaign = 'broadcast', params = {} }) {
      const batchId = `BATCH_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      let added = 0;

      for (const rec of recipients) {
        const item = typeof rec === 'string' ? { phone: rec } : { ...rec };
        queue.push({
          batchId,
          campaign,
          phone: item.phone,
          name: item.name || null,
          team: item.team || null,
          jid: item.jid || null,
          messageTemplate,
          params: { ...params, ...(item.params || {}) }
        });
        added++;
      }

      // Start queue processing asynchronously
      processQueue();
      return { batchId, queuedCount: added };
    },

    /**
     * Opt-out handler helper bound to this broadcaster's database.
     *
     * @param {string} phone
     * @param {string} [text]
     * @returns {Object}
     */
    handleOptOut(phone, text) {
      return handleOptOut({ phone, text, db });
    },

    /**
     * Opt-in handler helper bound to this broadcaster's database.
     *
     * @param {string} phone
     * @param {string} [text]
     * @returns {Object}
     */
    handleOptIn(phone, text) {
      return handleOptIn({ phone, text, db });
    },

    /**
     * Returns current operational status of the broadcaster.
     *
     * @returns {Object}
     */
    getStatus() {
      return {
        queueLength: queue.length,
        isRunning,
        activeWorkerCount,
        processedCount,
        sentCount,
        failedCount,
        skippedCount
      };
    },

    /**
     * Waits until the queue has been completely drained and the worker is idle.
     * Crucial for asynchronous unit tests.
     *
     * @returns {Promise<void>}
     */
    drain() {
      if (!isRunning && queue.length === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => drainResolvers.push(resolve));
    },

    /**
     * Clears all pending queued jobs.
     */
    clear() {
      queue.length = 0;
    },

    /**
     * Halts worker and clears queue.
     */
    stop() {
      this.clear();
      isRunning = false;
      activeWorkerCount = 0;
    }
  };
}

/**
 * Convenience helper to enqueue broadcast jobs.
 *
 * @param {Object} options - { recipients, messageTemplate, senderFn, db, campaign }
 * @returns {Promise<{ queued: number }>}
 */
export async function enqueueBroadcast(options = {}) {
  const { recipients = [], messageTemplate = '', senderFn, db, campaign = 'broadcast' } = options;
  const b = createBroadcaster({ db, senderFn });
  const res = await b.enqueue({ recipients, messageTemplate, campaign });
  return { queued: res.queuedCount };
}

export default {
  createBroadcaster,
  enqueueBroadcast,
  getRandomJitter,
  getRandomTypingDelay,
  personalizeMessage,
  isOptOutMessage,
  isOptInMessage,
  handleOptOut,
  handleOptIn,
  phoneToJid,
  findContactFlexible
};
