# Sender View

A Thunderbird add-on that gives you a chat-style, person-centric way to read your mail:
instead of one long inbox list, you get a contact list of everyone you've exchanged mail
with, and clicking a person shows your entire conversation with them — inbox and sent mail
interleaved, newest at the bottom or top as per your preference.

## Features

- **One conversation per person.** Every sender is grouped by email address across all
  your accounts, merging display-name variants ("Groupon" and "Groupon Deals" from the
  same address become one contact). Unread senders float to the top; a toggle switches to
  pure recency if you prefer that.
- **Read messages inline.** Message bodies open right in the conversation — HTML mail
  renders safely (see [Privacy & security](#privacy--security) below), the newest message
  auto-expands, older ones expand on click. Attachments show as chips that open the
  message in Thunderbird's native reader.
- **Reply without leaving the view.** A quick-reply box at the bottom sends through
  Thunderbird's real compose pipeline, so it threads correctly. Click ↩ on any message
  (including older ones) to reply to that specific email instead of the latest one — a
  chip always shows who the reply will actually reach, with a warning if it's more than
  one person. Need attachments, CC/BCC, or formatting? "Full compose" hands off to
  Thunderbird's normal compose window, carrying over anything you've typed.
- **Stay in sync with Thunderbird.** Marking read/unread, archiving, deleting, and
  reporting spam all use Thunderbird's real mail actions (delete goes to Trash, never
  permanent) and update instantly in both directions — actions taken here show up in
  Thunderbird's folder view and vice versa, live, without reopening the tab.
- **Everything persists.** Your sort preferences, last-viewed conversation, scroll
  position, and pane width are remembered across restarts.

## Privacy & security

- **No network calls, ever** — except one explicit, per-click exception: if a message has
  blocked images (see below), you can choose to load them for that message. Nothing else
  in the extension talks to the internet.
- **Remote images are blocked by default**, the same way Thunderbird's own reader blocks
  them, since they can be used to track whether/when you opened a message. A banner tells
  you how many were blocked with a **Load remote content** button if you want them anyway
  — the choice is per message and doesn't persist.
- **HTML mail is sandboxed.** Message content renders in an isolated frame with scripts
  and event handlers always stripped, regardless of whether you've loaded remote images.
- **Junk, Trash, and Archive folders never appear** in the view — only Inbox and Sent are
  read.

### Permissions this add-on requests, and why

| Permission | Why |
|---|---|
| `messagesRead` | Read your Inbox/Sent messages to build the conversation view |
| `messagesUpdate` | Mark messages read/unread, flag as junk |
| `messagesMove` | Archive messages, move spam to your Junk folder |
| `messagesDelete` | Delete messages (to Trash) |
| `accountsRead` | Discover your accounts' Inbox/Sent/Junk folders |
| `storage` | Remember your preferences locally |
| `compose`, `compose.send` | Send replies through Thunderbird's compose pipeline |

## Installing

**From addons.thunderbird.net:** not yet published there — for now, install from a
release below.

**From a downloaded `.xpi`:**
1. Thunderbird ▸ **Add-ons and Themes** ▸ gear icon ▸ **Install Add-on From File…**
2. Select the `.xpi` file.
3. If Thunderbird warns about an unsigned add-on, confirm the install — this is normal
   for add-ons installed outside the official store.

**Trying it from source (for development):**
1. Thunderbird ▸ ☰ menu ▸ **Add-ons and Themes** ▸ gear icon ▸ **Debug Add-ons**.
2. **Load Temporary Add-on…** ▸ select `manifest.json` from this repo.
3. It unloads when Thunderbird closes — use the `.xpi` install above for something
   permanent.

Requires Thunderbird 140 or later.

## Using it

- Click the **Sender View** icon in the left spaces rail to open the tab.
- The left pane lists everyone you've mailed or been mailed by; type in **Filter senders**
  to search, or toggle **Unread first** off for pure chronological order.
- Click a sender to open the conversation on the right. Toggle **Oldest first / Newest
  first** to change reading direction.
- Enable **Mark read on selection** beside the conversation controls to mark the
  automatically expanded message as read when selecting a sender. This preference is
  saved and off by default; restoring the previous conversation does not mark it read.
- Click a message bubble to expand or collapse it. Use the ✓/✉ button to mark it
  read/unread, or 📦 / 🗑 / 🚫 to archive, delete, or mark as spam — each also has a
  sender-level version above the conversation to act on every message from that person at
  once.
- Type in the box at the bottom to reply; **Send** or **Ctrl+Enter** sends it. Click ↩ on
  any message first if you want to reply to that one specifically instead of the latest.
- **Full compose ↗** opens Thunderbird's normal compose window when you need attachments,
  CC/BCC, or formatting.

## License

Mozilla Public License 2.0 — see [LICENSE](LICENSE).

## For developers

Architecture notes, locked product decisions, the testing workflow, and version history
live in [CLAUDE.md](CLAUDE.md).
