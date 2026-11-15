/**
 * tests/helpers/mockSocket.js
 * Baileys WhatsApp Socket Mock for ACTION Kinoquiz Bot Testing
 */
import { EventEmitter } from 'node:events';

/**
 * Creates an emulated Baileys WASocket for testing.
 * @param {Object} [options]
 * @param {string} [options.botJid='77011863190:0@s.whatsapp.net']
 * @param {string} [options.botName='ACTION Kinoquiz Bot']
 * @param {Object} [options.user]
 * @returns {Object} Mock socket instance with Baileys methods, inspection helpers, and simulation triggers
 */
export function createMockSocket(options = {}) {
  const ev = new EventEmitter();
  const sentMessages = [];
  const presenceUpdates = [];
  const readReceipts = [];

  let msgCounter = 0;
  let isClosed = false;

  const user = options.user || {
    id: options.botJid || '77011863190:0@s.whatsapp.net',
    name: options.botName || 'ACTION Kinoquiz Bot'
  };

  const sock = {
    user,
    ev,
    ws: {
      isOpen: true,
      close() {
        sock.ws.isOpen = false;
        sock.simulateDisconnect(428, 'Connection closed');
      }
    },

    // --- Standard Baileys WASocket Methods ---

    /**
     * Sends an outbound message to a JID.
     * @param {string} jid
     * @param {Object|string} content
     * @param {Object} [sendOptions={}]
     * @returns {Promise<Object>} Baileys message info
     */
    async sendMessage(jid, content, sendOptions = {}) {
      if (isClosed) {
        throw new Error('Cannot send message: Socket is closed');
      }

      msgCounter += 1;
      const msgId = `MOCK_MSG_${Date.now()}_${msgCounter}_${Math.random().toString(36).slice(2, 7)}`;

      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (content && typeof content === 'object') {
        if (typeof content.text === 'string') {
          text = content.text;
        } else if (content.extendedTextMessage && typeof content.extendedTextMessage.text === 'string') {
          text = content.extendedTextMessage.text;
        } else if (typeof content.caption === 'string') {
          text = content.caption;
        } else if (typeof content.conversation === 'string') {
          text = content.conversation;
        }
      }

      const normalizedContent = typeof content === 'string' ? { text: content } : (content || {});

      const recorded = {
        id: msgId,
        jid,
        content: normalizedContent,
        text,
        options: sendOptions,
        timestamp: Date.now(),
        key: {
          id: msgId,
          remoteJid: jid,
          fromMe: true
        }
      };

      sentMessages.push(recorded);

      return {
        key: recorded.key,
        message: normalizedContent.text ? { conversation: normalizedContent.text } : normalizedContent,
        messageTimestamp: Math.floor(Date.now() / 1000)
      };
    },

    /**
     * Sends presence update (e.g. 'composing', 'recording', 'paused', 'available').
     * @param {string} presence
     * @param {string} [jid]
     * @returns {Promise<void>}
     */
    async sendPresenceUpdate(presence, jid) {
      if (isClosed) {
        throw new Error('Cannot send presence update: Socket is closed');
      }

      presenceUpdates.push({
        presence,
        jid,
        timestamp: Date.now()
      });
    },

    /**
     * Marks messages as read.
     * @param {Array<Object>} keys
     * @returns {Promise<void>}
     */
    async readMessages(keys = []) {
      if (isClosed) {
        throw new Error('Cannot read messages: Socket is closed');
      }

      if (Array.isArray(keys)) {
        readReceipts.push(...keys);
      } else if (keys) {
        readReceipts.push(keys);
      }
    },

    /**
     * Closes the active socket connection.
     * @param {Error} [error]
     */
    end(error) {
      isClosed = true;
      sock.ws.isOpen = false;
      const disconnectErr = error || new Error('Socket closed');
      ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: {
          error: disconnectErr,
          date: new Date()
        }
      });
    },

    /**
     * Logs out the session (emits 401 DisconnectReason.loggedOut).
     * @returns {Promise<void>}
     */
    async logout() {
      isClosed = true;
      sock.ws.isOpen = false;
      const error = new Error('Logged out');
      error.output = { statusCode: 401 };
      ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: {
          error,
          date: new Date()
        }
      });
    },

    // --- Inspection Helpers ---

    sentMessages,
    presenceUpdates,
    readReceipts,

    /**
     * Retrieves the most recent outbound message, optionally filtered by JID.
     * @param {string} [jid]
     * @returns {Object|null}
     */
    getLastMessage(jid) {
      if (!jid) {
        return sentMessages.length > 0 ? sentMessages[sentMessages.length - 1] : null;
      }
      for (let i = sentMessages.length - 1; i >= 0; i--) {
        if (sentMessages[i].jid === jid) {
          return sentMessages[i];
        }
      }
      return null;
    },

    /**
     * Retrieves all sent messages, optionally filtered by JID.
     * @param {string} [jid]
     * @returns {Array<Object>}
     */
    getAllMessages(jid) {
      if (!jid) return [...sentMessages];
      return sentMessages.filter(m => m.jid === jid);
    },

    /**
     * Retrieves sent text strings, optionally filtered by JID.
     * @param {string} [jid]
     * @returns {Array<string>}
     */
    getSentTexts(jid) {
      return this.getAllMessages(jid).map(m => m.text);
    },

    /**
     * Retrieves recorded presence updates, optionally filtered by JID.
     * @param {string} [jid]
     * @returns {Array<Object>}
     */
    getPresenceUpdates(jid) {
      if (!jid) return [...presenceUpdates];
      return presenceUpdates.filter(p => p.jid === jid);
    },

    /**
     * Resets all recorded inspection stores.
     */
    clear() {
      sentMessages.length = 0;
      presenceUpdates.length = 0;
      readReceipts.length = 0;
      msgCounter = 0;
    },

    // --- Simulation Helpers ---

    /**
     * Simulates an incoming message dispatch from WhatsApp servers.
     * @param {Object} params
     * @param {string} params.jid
     * @param {string} params.text
     * @param {string} [params.pushName='Игрок']
     * @param {string} [params.id]
     * @param {boolean} [params.fromMe=false]
     * @param {boolean} [params.isEphemeral=false]
     * @param {number} [params.timestamp]
     * @returns {Object} Dispatched WAMessage
     */
    simulateIncomingMessage({
      jid,
      text,
      pushName = 'Игрок',
      id,
      fromMe = false,
      isEphemeral = false,
      timestamp
    }) {
      const msgId = id || `INCOMING_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      let messageContent = { conversation: text };

      if (isEphemeral) {
        messageContent = {
          ephemeralMessage: {
            message: { conversation: text }
          }
        };
      }

      const waMessage = {
        key: {
          remoteJid: jid,
          fromMe,
          id: msgId
        },
        pushName,
        messageTimestamp: timestamp || Math.floor(Date.now() / 1000),
        message: messageContent
      };

      ev.emit('messages.upsert', {
        type: 'notify',
        messages: [waMessage]
      });

      return waMessage;
    },

    /**
     * Emits a connection.update event.
     * @param {Object} update
     */
    simulateConnectionUpdate(update) {
      if (update.connection === 'open') {
        isClosed = false;
        sock.ws.isOpen = true;
      } else if (update.connection === 'close') {
        isClosed = true;
        sock.ws.isOpen = false;
      }
      ev.emit('connection.update', update);
    },

    /**
     * Simulates QR code generation event.
     * @param {string} [qrCode='2@MOCK_QR_CODE_DATA_STRING']
     */
    simulateQr(qrCode = '2@MOCK_QR_CODE_DATA_STRING') {
      ev.emit('connection.update', {
        connection: 'connecting',
        qr: qrCode
      });
    },

    /**
     * Simulates successful connection open.
     * @param {boolean} [isNewLogin=true]
     */
    simulateOpen(isNewLogin = true) {
      isClosed = false;
      sock.ws.isOpen = true;
      ev.emit('connection.update', {
        connection: 'open',
        isNewLogin
      });
    },

    /**
     * Simulates disconnect with specific status code (e.g. 401, 408, 428, 515).
     * @param {number} [statusCode=428]
     * @param {string} [message='Connection closed']
     */
    simulateDisconnect(statusCode = 428, message = 'Connection closed') {
      isClosed = true;
      sock.ws.isOpen = false;
      const error = new Error(message);
      error.output = { statusCode };
      ev.emit('connection.update', {
        connection: 'close',
        lastDisconnect: {
          error,
          date: new Date()
        }
      });
    },

    /**
     * Simulates credentials update event.
     * @param {Object} [creds={}]
     */
    simulateCredsUpdate(creds = {}) {
      ev.emit('creds.update', creds);
    }
  };

  return sock;
}

export default createMockSocket;
