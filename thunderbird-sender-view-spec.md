# Thunderbird Sender-View Extension — Build Spec

## 1. Project Summary

Build a Thunderbird WebExtension (MailExtension) that adds a **chat-style,
person-centric email view**: a left-hand list of unique senders (like a
messenger app's contact list) and a right-hand pane showing the full message
history with the selected sender, pulled across the Inbox and Sent folders
of all configured accounts.

This is a pure UI/aggregation layer on top of Thunderbird's existing
`browser.messages` API. It does **not** talk to IMAP/SMTP directly, does
not introduce any third-party server, and all data stays on the local
machine inside Thunderbird's own profile — consistent with a local-first,
no-third-party-processor architecture.

**Target platform:** Thunderbird 140+ (current ESR line as of 2026),
WebExtension (MailExtension) APIs only. No native binary components.

---

## 2. Core Design Decisions (locked in)

| Decision | Choice |
|---|---|
| UI placement | **Custom Tab** (full-window), not sidebar. Rationale: a two-pane sender/conversation layout needs real width; a sidebar would force a cramped single-column list with no room for message preview. A tab also mirrors the dedicated-tab UX of chat-style email clients. |
| Folder scope | **Inbox + Sent only**, across all configured accounts. Explicitly exclude Junk, Trash, and Archive. |
| Sender grouping key | Email address, lowercased, exact match. Display-name variants (e.g. "Groupon" vs "Groupon Deals" from the same address) are merged into one entry. |
| Display name shown | The **most recent** display name seen for that address (i.e. from the latest message), not the first-seen or alphabetically-first one. |
| Sender list sort order | **Unread senders first** (grouped at top), then by most recent message timestamp within each group (unread-first, then recency — not a strict global timestamp sort). |
| Reply behavior (Phase 3) | **Both**: a quick inline reply box within the conversation pane for fast replies, plus an "Open full compose" action that hands off to Thunderbird's native compose window for anything needing attachments, CC/BCC, formatting, etc. |
| Message rendering | Delegate actual message body rendering to Thunderbird's native reader wherever practical (via `messageDisplay.open()` or an embedded native message pane), rather than reimplementing HTML/attachment rendering — avoids duplicating security-sensitive parsing logic. |
| Data storage | No external storage. Use Thunderbird's existing message store as source of truth; any local extension state (e.g. UI prefs) via `browser.storage.local` only. |

---

## 3. Phased Build Plan

Build and ship in three phases. Each phase should be a working, loadable
extension — not a throwaway prototype — so it can be used daily while the
next phase is developed.

### Phase 1 — Read-Only Sender View (MVP core)

**Goal:** Prove out the core aggregation and browsing experience.

Features:
- New custom Tab, e.g. labeled "Sender View", opened via a
  toolbar button.
- On load, query all messages across Inbox + Sent folders of all accounts
  using `browser.messages.query()` / `browser.folders.query()` +
  `browser.messages.list()`.
- Group messages by sender email address (case-insensitive), using the
  most recent display name per group.
- Left pane: scrollable list of unique senders, showing:
  - Display name
  - Email address (secondary line)
  - Snippet or subject of most recent message
  - Timestamp of most recent message
  - Message count badge
- Sort order: unread-first, then recency (per section 2).
- Right pane: clicking a sender shows a chronological list of all
  messages with that address (Inbox + Sent interleaved), most recent
  at top or bottom (confirm during build — recommend bottom, chat-style).
- Clicking an individual message opens it via `browser.messageDisplay.open()`
  in Thunderbird's native message reader (new tab/window), so rendering,
  attachments, and security handling are all inherited from Thunderbird.
- No write operations of any kind in this phase (no marking read, no
  replying, no deleting).

Acceptance criteria:
- Opening the tab populates the sender list within a few seconds for a
  mailbox in the low tens of thousands of messages.
- Selecting a sender reliably shows every Inbox/Sent message from/to that
  address, correctly merged across display-name variants.
- No Junk/Trash/Archive messages appear anywhere in the view.

---

### Phase 2 — Read/Unread State + Live Updates

**Goal:** Make the view usable as a daily driver, not just a browser.

Features:
- Reflect real unread/read state per message (pull from
  `message.read` via `browser.messages.get()`), and reflect it live in
  both the sender list (unread count/badge) and conversation pane.
- Support marking messages read/unread from within the sender view
  (`browser.messages.update()`), both individually and "mark all read
  for this sender."
- Live updates: listen to `browser.messages.onNewMailReceived` and
  relevant folder/message change events so the sender list and open
  conversation update without a manual refresh/re-open of the tab.
- Basic performance work: incremental/paginated loading rather than
  fetching the entire Inbox+Sent history up front (e.g. load most recent
  N per sender, lazy-load older messages on scroll).
- Persist last-used UI state (last selected sender, scroll position,
  pane widths) via `browser.storage.local`.

Acceptance criteria:
- Unread state in the extension always matches Thunderbird's native
  folder view (no drift).
- New incoming mail appears in the correct sender group without
  reopening the tab.
- Initial load time for the sender list doesn't materially regress vs.
  Phase 1 despite added live-update overhead.

---

### Phase 3 — Reply / Compose Integration

**Goal:** Make the sender view a place you can fully work from, not just
read from.

Features:
- Inline quick-reply box at the bottom of the conversation pane:
  - Plain-text or basic rich-text reply
  - Sends via Thunderbird's compose/send pipeline
    (`browser.compose.beginReply()` + `browser.compose.sendMessage()`,
    or equivalent current API — confirm exact API surface against the
    Thunderbird version in use at build time, as compose APIs have
    evolved across releases)
  - No attachment support in the inline box (by design — keep it fast)
- "Open full compose" button/action: hands off to Thunderbird's native
  compose window (pre-filled with recipient/thread context) for anything
  needing attachments, CC/BCC, signatures, formatting, templates, etc.
- After sending (either path), the new outgoing message should appear
  immediately in that sender's conversation history (Sent folder is in
  scope per section 2).
- Optional/nice-to-have if time allows: minimal per-sender quick actions
  (archive-all-from-sender excluded per scope, but e.g. "open all
  messages from this sender in native search" is reasonable).

Acceptance criteria:
- Inline replies are indistinguishable from native Thunderbird replies
  in terms of headers/threading (In-Reply-To, References set correctly).
- Full-compose handoff correctly pre-fills recipient and quoted context.
- Sent messages appear in the conversation pane without manual refresh.

---

## 4. Technical Notes for Claude Code

- **Manifest:** MailExtension `manifest_version: 3` (or current
  Thunderbird-supported version — verify against installed Thunderbird
  version at build time), with `messagesRead`, `messagesUpdate`,
  `accountsRead`, `compose`, and `tabs` permissions as needed per phase.
- **UI stack:** Plain HTML/CSS/JS is sufficient and keeps the extension
  lightweight; no build tooling required unless preferred. If a
  lightweight framework is wanted for state management (sender list +
  selected conversation + live updates), a small one is fine, but avoid
  heavy bundlers given the extension's modest UI surface.
- **No external network calls.** All data comes from local Thunderbird
  APIs only. This should be treated as a hard constraint, not just a
  default — nothing in this extension should phone out to any server.
- **Multi-account handling:** Iterate `browser.accounts.list()` and
  query Inbox/Sent per account; do not hardcode a single account.
- **Testing:** Use a Thunderbird profile with realistic volume (mix of
  personal + high-traffic mailing-list-style senders) to validate
  grouping and performance, given real-world mailbox sizes.

---

## 5. Out of Scope (explicitly, for all phases above)

- Junk/Trash/Archive folders
- Any cloud sync, backup, or external storage of message data
- End-to-end rebuild of message rendering/HTML sanitization (reuse
  Thunderbird's native reader instead)
- Calendar, tasks, or other non-email Thunderbird features
- Cross-device sync of extension state (local-only by design)
