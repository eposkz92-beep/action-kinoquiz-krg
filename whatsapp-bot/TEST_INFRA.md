# E2E Test Infra: ACTION Kinoquiz WhatsApp Bot

## Test Philosophy
- Opaque-box, requirement-driven. No dependency on implementation internals.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial + Real-World Workload Testing.
- 100% Autonomous & Offline: No real WhatsApp connections, external network calls, or paid gateways.
- Runner: Node.js built-in test runner (`node --test`, `node:test`, `node:assert/strict`).

## Feature Inventory & Test Coverage Matrix
| # | Feature Area | Requirement | Description | Tier 1 (Min 5) | Tier 2 (Min 5) | Tier 3 (Pairwise) | Tier 4 (Workload) |
|---|--------------|-------------|-------------|:--------------:|:--------------:|:-----------------:|:-----------------:|
| F1 | WhatsApp Gateway & Auth Lifecycle | R1 | Baileys socket emulation, QR display event, creds save, reconnect codes (401, 515, 408) | 5 | 5 | 2 | 1 |
| F2 | Menu Navigation & Inactivity | R2 | 1-5 main menu, invalid inputs, back/cancel commands (0, назад, отмена), session timeout | 5 | 5 | 3 | 2 |
| F3 | Interactive Booking FSM | R2 | 5-step state machine: team -> players (2-10) -> game selection -> captain name -> confirmation card | 5 | 6 | 3 | 2 |
| F4 | Web Booking Interceptor | R2 | Pre-filled website modal format regex parsing, direct confirmation card generation | 5 | 5 | 2 | 1 |
| F5 | Storage Engine & Data Exports | R3 | SQLite table schema, CRUD operations, CSV export (BOM + escaping), Google Sheets sync stub | 5 | 5 | 3 | 2 |
| F6 | Telegram Organizer Alerting | R4 | Structured HTML card notification to Telegram Bot API upon booking, error isolation | 5 | 5 | 3 | 1 |
| F7 | Broadcast Queue & Anti-Ban | R5 | Queue serialization, randomized 3-7s delay, typing presence, "СТОП" opt-out handling | 5 | 5 | 2 | 2 |
| F8 | Game Day Reminders (Tuesday 12:00) | R5 | Tuesday 12:00 cron trigger for tonight's captains, target game filtering | 5 | 5 | 2 | 2 |

**Coverage Totals**:
- Tier 1: Feature Coverage (40 test cases across 8 feature areas)
- Tier 2: Boundary & Corner Cases (41 test cases across boundary conditions)
- Tier 3: Cross-Feature Interactions (20 pairwise/cross-feature integration cases)
- Tier 4: Real-World Application Scenarios (13 multi-step realistic end-to-end journeys)
- **Grand Total**: 114 test cases

---

## Test Architecture

### 1. Test Runner & Invocation
- Invocation command: `node --test tests/e2e.test.js` or `npm test`
- Pass/Fail Semantics: Exit code 0 indicates 100% pass across all assertions. Non-zero exit code on failure.
- Zero external runtime test framework dependencies (uses `node:test` and `node:assert/strict` native to Node.js v18+).

### 2. Directory Layout
```
whatsapp-bot/tests/
├── helpers/
│   ├── mockSocket.js        # Baileys WhatsApp socket emulator (EventEmitter + sent message store)
│   ├── mockTelegram.js      # In-memory Telegram Bot API interceptor / recorder
│   ├── mockGoogleSheets.js  # Google Sheets Service Account mock
│   └── testEnv.js           # Isolated temporary SQLite DB & fixture setup/teardown
├── fixtures/
│   ├── instagram_state.json # Mock catalog with open & past games
│   └── service_account.json # Mock Google credentials
├── tier1_feature.test.js    # Tier 1: 40 feature-specific isolated happy-path tests
├── tier2_boundary.test.js   # Tier 2: 41 boundary, corner-case & negative validation tests
├── tier3_cross_feature.test.js # Tier 3: 20 cross-module interaction tests
├── tier4_real_world.test.js # Tier 4: 13 end-to-end full user journeys
└── e2e.test.js              # Full master suite runner importing and running Tiers 1-4
```

### 3. Mock Specifications

#### Mock WhatsApp Socket (`tests/helpers/mockSocket.js`)
- Extends `EventEmitter` to emulate Baileys event dispatch (`ev.emit`, `ev.on`).
- Implements:
  - `ev.emit('connection.update', { qr, connection, lastDisconnect })`
  - `ev.emit('messages.upsert', { messages: [ ... ] })`
  - `ev.emit('creds.update', authState.creds)`
  - `sendMessage(jid, content, options)` -> stores sent message in `sentMessages[]` array, returns `{ key: { id: 'msg-id', remoteJid: jid } }`
  - `sendPresenceUpdate(presence, jid)` -> stores presence updates in `presenceUpdates[]`
  - `user`: `{ id: 'bot@s.whatsapp.net', name: 'ACTION Kinoquiz Bot' }`
- Helper inspection methods:
  - `getLastMessage(jid)`
  - `getAllMessages(jid)`
  - `clear()`

#### Mock Telegram Interceptor (`tests/helpers/mockTelegram.js`)
- Intercepts or stubs `fetch`/`https.request` calls directed to `https://api.telegram.org/bot*` or provides mock dispatcher.
- Records all outgoing notifications: `{ chatId, text, parse_mode, timestamp }`.
- Allows simulating Telegram API errors (429 Rate Limit, 500 Server Error) to verify bot resilience.

#### Mock Google Sheets (`tests/helpers/mockGoogleSheets.js`)
- Stubs Google Sheets API calls (`spreadsheets.values.append`, etc.).
- Records appended rows and verifies schema format.

---

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Full Happy-Path Booking via Menu | F1, F2, F3, F5, F6 | High |
| 2 | Direct Website Modal Booking Flow | F1, F4, F5, F6 | Medium |
| 3 | Captain Opt-Out ("СТОП") followed by Broadcast | F5, F7 | Medium |
| 4 | Tuesday 12:00 Game Day Auto-Reminder Delivery | F5, F7, F8 | High |
| 5 | Team Size Validation Retry during Active Booking | F2, F3 | Medium |
| 6 | Menu Inactivity Timeout and State Reset | F2, F3 | Medium |
| 7 | Booking Cancellation via 'отмена' midway | F2, F3 | Medium |
| 8 | Multiple Concurrent Users Registering Different Teams | F1, F2, F3, F5 | High |
| 9 | Duplicate Registration Handling for Same Game & Team | F3, F5 | High |
| 10| CSV Export Verification after Multiple Bookings | F3, F5 | Medium |
| 11| Google Sheets Sync with Intermittent Network Error | F4, F5 | High |
| 12| Telegram API Failure Does Not Block Booking Confirmation | F3, F5, F6 | High |
| 13| High-Volume Broadcast Queue Throttling (3-7s Delays) | F7 | High |
