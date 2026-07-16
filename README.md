# Sender View — Thunderbird Extension (Phase 3 — feature complete)

Chat-style, person-centric view of Inbox + Sent across all accounts.

**Phase 3 (this build)** completes the spec with reply/compose integration:

- **Quick reply bar** at the bottom of the conversation pane: type and hit
  Send (or Ctrl+Enter). The reply goes through Thunderbird's real compose
  pipeline (`compose.beginReply` → `sendMessage`), so threading headers
  (In-Reply-To/References) are native-correct and your text is placed above
  the quoted original. A compose window flashes briefly during send — that's
  the native pipeline doing the work. Unsent text is kept as a per-sender
  draft while the tab is open; on failure the compose window stays open with
  your text.
- **Per-message reply targeting** (v0.5.0): every message has an ↩ button
  that aims the quick-reply bar at *that* message, so replies thread under
  the email you chose (the targeted bubble is outlined; ✕ returns to the
  default latest-message target, which resets automatically after sending).
  The chip above the box always shows the current target and the computed
  **reply-all audience**; it turns amber when the reply would reach more than
  one person — use Full compose to prune recipients in that case. ↩ on your
  own sent messages replies to their original recipients (native behavior).
- **Full compose ↗** hands off to Thunderbird's native compose window
  (pre-filled with recipient + quoted context, carrying over anything you
  typed in the quick-reply box) for attachments, CC/BCC, formatting.
- Sent replies appear in the conversation immediately (Sent-folder events +
  `compose.onAfterSend`).
- Senders you've only ever written to get `beginNew` with a "Re:" subject
  instead of a reply (nothing to reply to).

- **"Unread first" toggle** (v0.5.1) above the sender list: on (default) groups
  unread senders at the top; off sorts purely by most recent message. Persists
  across sessions.
- **Archive / Spam / Delete actions** (v0.6.0): 📦 🚫 🗑 on every message
  bubble (instant) and on every sender row (bulk over that sender's *received*
  messages, with a confirmation showing the count). Delete always moves to
  Trash — never permanent. Spam flags messages as junk *and* moves them to the
  account's Junk folder. Actioned mail disappears from the view automatically
  via the live folder events. Requires the `messagesMove` and `messagesDelete`
  permissions (prompted on install).

**Phase 2** features:

- **Read/unread actions**: clicking to expand an unread message marks it read
  (the auto-expanded newest message deliberately does not); per-message
  read/unread toggle (✓/✉); "Mark all read" per sender. All synced to
  Thunderbird via `messages.update`.
- **Live updates**: new mail, read-state changes made in native Thunderbird,
  moves and deletions all stream in via `messages.on*` events — no manual
  refresh needed while the tab is open. Chat view stays pinned to the newest
  message if you're already at the bottom.
- **Incremental loading**: conversations render the newest 60 messages; older
  ones load on scroll or via the "Show older" pill.
- **Persistent UI state**: last selected sender, conversation scroll position,
  sort order, and pane width (drag the divider between panes) survive restarts.

Still true: HTML mail renders in a sandboxed iframe (scripts stripped/blocked,
remote images/trackers blocked via CSP), links open in the system browser,
no Junk/Trash/Archive folders in view. One user-initiated exception to the
no-network rule (v0.6.1): when a message has blocked remote content, a banner
shows the count with a **Load remote content** button — clicking it re-renders
that one message with remote *images* allowed (scripts stay stripped in all
modes). Per message, per session; nothing loads without the click.

## Try it (temporary, for development)

1. Thunderbird ▸ ☰ menu ▸ **Add-ons and Themes** ▸ gear icon ▸ **Debug Add-ons**
   (or Tools ▸ Developer Tools ▸ Debug Add-ons).
2. **Load Temporary Add-on…** ▸ select `manifest.json` in this folder.
3. A **Sender View** button appears in the left spaces rail — click it.

Temporary add-ons unload when Thunderbird closes.

## Install permanently

1. Thunderbird ▸ **Add-ons and Themes** ▸ gear icon ▸ **Install Add-on From File…**
2. Select `sender-view-0.6.3.xpi`.
3. If Thunderbird refuses unsigned add-ons, this is a Release-channel
   restriction; on current Thunderbird, unsigned local installs are normally
   allowed and it will just show a confirmation prompt.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 MailExtension manifest (`messagesRead`, `messagesUpdate`, `messagesMove`, `messagesDelete`, `accountsRead`, `storage`, `compose`, `compose.send`) |
| `background.js` | Registers the Sender View space in the spaces rail |
| `senderview/` | The tab UI: query, grouping, rendering |
| `icons/senderview.svg` | Space/extension icon |

## License

Mozilla Public License 2.0 — see [LICENSE](LICENSE).

## Status

All three spec phases are implemented. Skipped by design: unread badge on the
spaces-rail button (needs a persistent background observer and duplicates
native Thunderbird badges); attachment access from the inline view (chips
open the native reader instead).
