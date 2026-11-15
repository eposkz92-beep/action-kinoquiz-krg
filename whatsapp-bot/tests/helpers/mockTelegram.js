/**
 * tests/helpers/mockTelegram.js
 * In-Memory Telegram Bot API Mock & Global Fetch Interceptor for ACTION Kinoquiz Bot Testing
 */

/**
 * Creates an emulated Telegram Bot API service and fetch interceptor.
 * @returns {Object} Mock Telegram controller
 */
export function createMockTelegram() {
  const requests = [];
  let originalFetch = null;
  let currentStatus = 200;
  let customResponseBody = null;
  let nextNetworkError = null;

  /**
   * Parses outgoing request body from fetch call.
   * @param {any} body
   * @param {Object} [headers={}]
   * @returns {any} Parsed payload
   */
  function parseRequestBody(body, headers = {}) {
    if (!body) return null;
    if (typeof body === 'object' && !(body instanceof String)) {
      return body;
    }

    const strBody = String(body);
    // Check if JSON
    try {
      return JSON.parse(strBody);
    } catch {
      // Try URLSearchParams
      try {
        const params = new URLSearchParams(strBody);
        const obj = {};
        let hasKeys = false;
        for (const [k, v] of params.entries()) {
          obj[k] = v;
          hasKeys = true;
        }
        if (hasKeys) return obj;
      } catch {
        // Fallback to raw string
      }
      return strBody;
    }
  }

  /**
   * The fetch interceptor implementation.
   */
  async function mockFetch(url, options = {}) {
    const urlStr = String(url);

    // Only intercept calls targeting Telegram Bot API
    if (urlStr.includes('api.telegram.org')) {
      // 1. Fault injection: Network-level failure
      if (nextNetworkError) {
        const err = nextNetworkError;
        nextNetworkError = null;
        throw err;
      }

      // 2. Extract payload
      let payload = parseRequestBody(options.body, options.headers);

      // Also extract URL search params if present
      try {
        const parsedUrl = new URL(urlStr);
        if (parsedUrl.searchParams && [...parsedUrl.searchParams.keys()].length > 0) {
          const queryObj = {};
          for (const [k, v] of parsedUrl.searchParams.entries()) {
            queryObj[k] = v;
          }
          payload = payload && typeof payload === 'object' ? { ...queryObj, ...payload } : queryObj;
        }
      } catch {
        // Ignore URL parsing errors
      }

      const recorded = {
        url: urlStr,
        method: (options.method || 'GET').toUpperCase(),
        headers: options.headers || {},
        payload,
        timestamp: Date.now()
      };
      requests.push(recorded);

      // 3. Status and Response construction
      const status = currentStatus;
      const isOk = status >= 200 && status < 300;

      let responseData;
      if (customResponseBody !== null) {
        responseData = customResponseBody;
      } else if (isOk) {
        responseData = {
          ok: true,
          result: {
            message_id: 1000 + requests.length,
            date: Math.floor(Date.now() / 1000),
            chat: {
              id: payload?.chat_id || -1001234567890,
              type: 'supergroup',
              title: 'ACTION Kinoquiz Alerts'
            },
            text: payload?.text || ''
          }
        };
      } else if (status === 429) {
        responseData = {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 5',
          parameters: {
            retry_after: 5
          }
        };
      } else {
        responseData = {
          ok: false,
          error_code: status,
          description: status === 400 ? 'Bad Request: invalid parameters' : 'Telegram API Server Error'
        };
      }

      const responseHeaders = new Headers({
        'Content-Type': 'application/json'
      });
      if (status === 429) {
        responseHeaders.set('Retry-After', '5');
      }

      return {
        ok: isOk,
        status,
        statusText: isOk ? 'OK' : 'Error',
        headers: responseHeaders,
        json: async () => responseData,
        text: async () => JSON.stringify(responseData)
      };
    }

    // Pass through non-Telegram calls to original globalThis.fetch
    if (originalFetch) {
      return originalFetch(url, options);
    }

    throw new Error(`Unhandled non-mocked fetch request to: ${urlStr}`);
  }

  const mockTelegram = {
    requests,

    /**
     * Installs the mock interceptor on globalThis.fetch.
     */
    install() {
      if (!originalFetch) {
        originalFetch = globalThis.fetch;
        globalThis.fetch = mockFetch;
      }
    },

    /**
     * Uninstalls the mock interceptor and restores original globalThis.fetch.
     */
    uninstall() {
      if (originalFetch) {
        globalThis.fetch = originalFetch;
        originalFetch = null;
      }
    },

    /**
     * Sets HTTP status code and optional body for subsequent Telegram calls.
     * @param {number} code
     * @param {Object|null} [body=null]
     */
    setStatus(code, body = null) {
      currentStatus = Number(code) || 200;
      customResponseBody = body;
    },

    /**
     * Injects a network error on the very next Telegram API request.
     * @param {Error} [error=new TypeError('fetch failed')]
     */
    failNext(error = new TypeError('fetch failed')) {
      nextNetworkError = error;
    },

    /**
     * Returns the payload of the most recent Telegram alert.
     * @returns {Object|undefined}
     */
    getLastAlert() {
      if (requests.length === 0) return undefined;
      return requests[requests.length - 1].payload;
    },

    /**
     * Returns all recorded Telegram alert payloads.
     * @returns {Array<Object>}
     */
    getAlerts() {
      return requests.map(r => r.payload);
    },

    /**
     * Clears all recorded requests and resets fault injection.
     */
    clear() {
      requests.length = 0;
      currentStatus = 200;
      customResponseBody = null;
      nextNetworkError = null;
    }
  };

  return mockTelegram;
}

export default createMockTelegram;
