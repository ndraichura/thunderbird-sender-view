# CLAUDE.md — Sender View (Thunderbird MailExtension)

## What this project is

A Thunderbird WebExtension that adds a chat-style, **person-centric email view**: a
spaces-rail tab with a left pane of unique senders and a right pane showing the full
conversation (Inbox + Sent interleaved) with the selected person, across all accounts.
All three original spec phases are implemented, plus several post-spec features (see
version history below). User-facing docs: [README.md](README.md).

- **Target:** Thunderbird 140+ (user runs 152.x, monthly channel), Manifest V3.
- **Stack:** plain HTML/CSS/JS, no build tooling, no dependencies, no bundler.
- **License:** MPL-2.0 (`LICENSE`; Exhibit A headers on the JS files — keep them on new
  source files).
- **Add-on ID (permanent — NEVER change):** `{79c9baab-f570-4e8a-9721-82d2d2fab86c}`.
  This is the extension's identity on addons.thunderbird.net and in every user profile;
  changing it orphans all installs.
- **Public repo policy:** no third-party product/trademark names (e.g. other email
  clients or messengers) in code, docs, or the manifest — describe features generically
  ("chat-style", "person-centric").
- **Hard constraint:** no external network calls. Sole exception (user-approved): the
  per-message "Load remote content" button (v0.6.1), which is explicit per-click opt-in.
- API reference used throughout: https://webextension-api.thunderbird.net/en/latest/
  (verify against it before using new APIs — TB API surface moves between releases).

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3; permissions: `messagesRead`, `messagesUpdate`, `messagesMove`, `messagesDelete`, `accountsRead`, `storage`, `compose`, `compose.send` |
| `background.js` | Only registers the spaces-rail button (`browser.spaces.create`) on startup |
| `senderview/senderview.js` | Everything else: query, grouping, rendering, actions, live events (~1300 lines) |
| `senderview/senderview.html` / `.css` | Two-pane layout, draggable divider, reply bar; light/dark via `prefers-color-scheme` |
| `icons/senderview.svg` | Space + extension icon |
| `sender-view-<version>.xpi` | Current installable package (old ones are deleted on rebuild) |

## Architecture (senderview.js)

- **Data flow:** `loadAll()` finds Inbox/Sent/Junk folder ids via
  `folders.query({specialUse})`, pages through `messages.query()` +
  `continueList` (headers only, never bodies up front), and `ingestPage()` groups by
  counterpart email (lowercased): received → author; sent → each external To recipient
  (own identity addresses from `accounts.list()` are excluded; sent-to-self falls back to
  self). `msgIndex` (Map id → [{group, msg}]) makes live events O(1); a header can belong
  to multiple groups (multi-recipient sent mail).
- **Live updates:** listeners registered on the page itself (not background):
  `onNewMailReceived`, `onUpdated` (read state), `onMoved`, `onCopied`, `onDeleted`,
  `compose.onAfterSend`. All funnel into `scheduleRender()` (250 ms debounce).
  `ingestPage` skips known ids, so handlers are idempotent.
- **Rendering:** sender list renders in rAF chunks; conversation renders newest
  `convLimit` (60) messages with "Show older" + scroll auto-load and scrollTop-delta
  anchoring. Chat view pins to bottom through async content fills (snippets, bodies,
  iframe sizing) — see `restick`/`wasPinned` pattern; keep it when touching render code.
- **Bodies:** lazy per message via `messages.listInlineTextParts` (+ `listAttachments`),
  cached in `bodyCache` (cap 300, drop oldest third). Snippets for collapsed bubbles load
  lazily (IntersectionObserver **plus** `primeVisibleSnippets()` fallback — IO callbacks
  don't fire in the headless test pane, and the fallback also covers initial render).
- **HTML mail security:** `sanitizeHtml(html, allowRemote)` — strips
  script/link/object/iframe/form/meta/base/media tags, all `on*` attrs, `javascript:`
  hrefs; remote `src/srcset/poster/background` stripped into `data-blocked-*` unless
  `allowRemote` (per-message, session-only `remoteAllowed` Set). CSP `<meta>` injected as
  backstop (`img-src data: cid:` strict / `+ https: http:` when opted in). Rendered into
  `<iframe sandbox="allow-same-origin" srcdoc>` — **never** `allow-scripts`; same-origin
  is what enables auto-height + link interception (`windows.openDefaultBrowser`).
  Scripts stay stripped in ALL modes. User text is always inserted via
  `textContent`/text nodes — never innerHTML.
- **Read/unread:** optimistic `applyReadState()` + `messages.update`; native changes come
  back via `onUpdated` (idempotent echo). Click-expand marks read; the auto-expanded
  newest message deliberately does NOT.
- **Reply pipeline:** `beginComposeFor()` → `compose.beginReply(target.id, "replyToAll")`
  (or `beginNew` with `Re:` subject for sent-only contacts) → `injectReplyText()` places
  typed text above the native quote (respects `isPlainText`) → `sendMessage({mode:
  "sendNow"})` → best-effort `tabs.remove`. On failure: compose window stays open, draft
  kept. A compose window flashing during send is inherent to the API — accepted.
- **Reply targeting:** `state.replyTarget` (↩ on any bubble) with an **always-visible
  chip** showing target subject + computed reply-all audience (`audienceFor` via shared
  `headerCache`/`fetchFullHeader`); `.multi` amber warning when >1 person. Resets on
  send/✕/sender switch/target removal.
- **Archive/Delete/Spam:** per-message buttons + per-sender bulk buttons (confirm dialog
  for bulk). Delete → Trash (`messages.delete(ids, {isUserAction:true})`, never
  permanent), spam → `update({junk:true})` then move to the account's Junk folder
  (`junkFolderByAccount`; if the account has none, flag-only), archive →
  `messages.archive`. Received messages only for spam. UI removal is event-driven
  (onMoved/onDeleted), not optimistic.
- **Persistence (`storage.local`):** `convSortAsc`, `unreadFirst`, `lastSelectedKey`,
  `convScrollTop`, `paneWidth`. In-memory only: drafts per sender, expanded ids,
  remote-content opt-ins.

## Locked product decisions (do not re-litigate without the user)

- Grouping key = lowercased email; display name = most recent seen.
- Sender list: unread-first block then recency; user toggle can switch to pure recency.
- Conversation: asc/desc toggle, chat-style bottom default; newest auto-expands.
- Quick replies: reply-**all**, typed text above quoted original, Ctrl+Enter or Send.
- ↩ on sent messages = native behavior (original recipients); amber chip is the guardrail.
- No unread badge on the spaces button (needs persistent background; duplicates native).
- Junk/Trash/Archive folders never appear in the view.

## Dev workflow

- **Static checks:** `node --check senderview/senderview.js`; parse manifest.json.
- **Functional verification (the established pattern):** serve the folder with a tiny
  node http server on `127.0.0.1:8321` (background Bash), open
  `senderview/senderview.html` in the Claude browser pane, inject a mock `window.browser`
  (storage/accounts/folders/messages/compose/tabs/windows + captured event listeners) via
  `javascript_tool`, call `init()`, then assert against DOM + recorded mock calls in
  staged `setTimeout` chains (results stashed on `window.__stageX`, read in a follow-up
  exec). Waits ≥400 ms cover the 250 ms render debounce. Quirks of that pane: screenshots
  time out and IntersectionObserver never fires (no compositor frames) — rely on DOM
  assertions, not visuals; kill the server by port afterwards
  (`Get-NetTCPConnection -LocalPort 8321`).
- **Packaging:** zip via .NET `System.IO.Compression` with **forward-slash entry names**
  (`Compress-Archive` writes backslashes, which Thunderbird can reject), manifest at zip
  root, named `sender-view-<version>.xpi`; delete the previous xpi. Bump
  `manifest.json` version on every user-visible change. README's install instructions
  deliberately don't pin a version/filename — keep it that way so releases don't require
  a doc edit.
- **Live testing** is the user's step: Thunderbird ▸ Add-ons ▸ Debug Add-ons ▸ Load
  Temporary Add-on ▸ `manifest.json`. Permission additions prompt on xpi install.
- Real-profile scale reference: ~785 senders / ~24k messages loads in a few seconds.

## Version history

- **0.1.0** Phase 1: read-only sender view, spaces tab, native-reader open.
- **0.2.0** Phase 1.5 (scope change): inline content — sandboxed HTML, snippets,
  expand/collapse, attachment chips.
- **0.3.0** Phase 2: read/unread sync both ways, live events, 60-message windowing,
  persisted UI state, draggable divider.
- **0.4.0** Phase 3: quick-reply bar + full-compose handoff, per-sender drafts.
- **0.5.0** Per-message reply targeting (↩), always-visible audience chip, reply-all.
- **0.5.1** "Unread first" toggle above sender list. **0.5.2** narrow-pane header
  overflow fix (`#filter` min-width). **0.5.3** From/To/Cc/Bcc block in expanded
  messages (shared `headerCache`).
- **0.6.0** Archive/Delete/Spam: per-message + per-sender bulk with confirmations;
  `messagesMove`/`messagesDelete` permissions added.
- **0.6.1** Per-message "Load remote content" banner (images only, session-scoped).
- **0.6.2** Public-release prep: trademark references scrubbed, MPL-2.0 license added.
- **0.6.3** Permanent UUID add-on id (replaces the initial domain-style placeholder).
- **0.7.0** Per-sender conversation search: a search bar atop the right pane filters the
  selected sender's messages by subject + body text (bodies indexed lazily on demand),
  with matches highlighted (`<mark>`). Resets when the sender selection changes.
