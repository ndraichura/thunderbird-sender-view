/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

/*
 * Sender View — Phase 2 (read/unread state + live updates).
 * Aggregates message headers from Inbox + Sent of all accounts and groups
 * them by counterpart email address. Bodies render inline (HTML in a
 * sandboxed iframe, scripts/remote content blocked). Read state can be
 * changed from the view; native changes, new mail, moves and deletions
 * stream in live via messages.* events. UI state persists across sessions.
 */

const CONV_PAGE = 60;

const state = {
  groups: new Map(),        // key: lowercased email -> group object
  inboxFolderIds: new Set(),
  sentFolderIds: new Set(),
  junkFolderByAccount: new Map(), // accountId -> junk folder id
  ownAddresses: new Set(),
  selectedKey: null,
  sortAsc: true,            // conversation pane: true = oldest first (chat-style)
  unreadFirst: true,        // sender list: group unread senders at the top
  markReadOnSelect: false,  // mark the auto-expanded message read on sender selection
  filterText: "",
  loading: false,
  totalMessages: 0,
  listRenderGen: 0,         // cancels stale chunked renders
  expandedIds: new Set(),   // message ids expanded in the current conversation
  expandInit: false,        // newest message auto-expanded yet for this sender?
  snippetScrollTimer: null,
  convLimit: CONV_PAGE,     // how many newest messages the conversation renders
  loadingOlder: false,
  pendingScrollRestore: null, // scrollTop to apply after next conversation render
  didRestore: false,
  saved: {},                // values loaded from storage.local at startup
  sending: false,           // quick reply in flight
  replyDraftKey: null,      // sender whose draft the textarea currently holds
  replyTarget: null,        // explicit reply anchor (msg), null = latest received
  chipGen: 0,               // cancels stale async chip updates
};

const drafts = new Map();        // sender key -> unsent quick-reply text
const audienceCache = new Map(); // messageId -> [{name, email}] reply-all audience
const headerCache = new Map();   // messageId -> full MessageHeader (author/to/cc/bcc)
const remoteAllowed = new Set(); // messageIds the user opted into remote content (session-only)

const msgIndex = new Map();  // messageId -> [{group, msg}]
const bodyCache = new Map(); // messageId -> {html, text, attachments, snippet, error}
const BODY_CACHE_MAX = 300;

const els = {
  filter: document.getElementById("filter"),
  unreadFirstToggle: document.getElementById("unread-first-toggle"),
  refresh: document.getElementById("refresh"),
  senderList: document.getElementById("sender-list"),
  status: document.getElementById("status"),
  left: document.getElementById("left"),
  divider: document.getElementById("pane-divider"),
  convHeader: document.getElementById("conv-header"),
  convName: document.getElementById("conv-name"),
  convEmail: document.getElementById("conv-email"),
  convCount: document.getElementById("conv-count"),
  markAllRead: document.getElementById("mark-all-read"),
  markReadOnSelect: document.getElementById("mark-read-on-select"),
  sortToggle: document.getElementById("sort-toggle"),
  convList: document.getElementById("conv-list"),
  convEmpty: document.getElementById("conv-empty"),
  replyBar: document.getElementById("reply-bar"),
  replyText: document.getElementById("reply-text"),
  replySend: document.getElementById("reply-send"),
  replyFull: document.getElementById("reply-full"),
  replyChip: document.getElementById("reply-chip"),
  replyChipText: document.getElementById("reply-chip-text"),
  replyChipClear: document.getElementById("reply-chip-clear"),
};

// Lazily fills 2-line snippets on collapsed bubbles as they scroll into view.
const snippetObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      snippetObserver.unobserve(entry.target);
      loadSnippet(entry.target);
    }
  },
  { root: els.convList, rootMargin: "200px" }
);

init();

async function init() {
  els.filter.addEventListener("input", () => {
    state.filterText = els.filter.value.trim().toLowerCase();
    renderSenderList();
  });
  els.refresh.addEventListener("click", () => loadAll());
  els.unreadFirstToggle.addEventListener("click", toggleUnreadFirst);
  els.sortToggle.addEventListener("click", toggleSort);
  els.markAllRead.addEventListener("click", markAllRead);
  els.markReadOnSelect.addEventListener("change", async () => {
    state.markReadOnSelect = els.markReadOnSelect.checked;
    await browser.storage.local.set({ markReadOnSelect: state.markReadOnSelect });
  });
  els.convList.addEventListener("scroll", () => {
    if (state.snippetScrollTimer) return;
    state.snippetScrollTimer = setTimeout(() => {
      state.snippetScrollTimer = null;
      primeVisibleSnippets();
      maybeAutoLoadOlder();
    }, 150);
  }, { passive: true });
  window.addEventListener("beforeunload", saveSession);
  initPaneDivider();

  els.replySend.addEventListener("click", quickSend);
  els.replyFull.addEventListener("click", openFullCompose);
  els.replyChipClear.addEventListener("click", () => {
    setReplyTarget(null);
    els.replyText.focus();
  });
  els.replyText.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      quickSend();
    }
  });
  els.replyText.addEventListener("input", () => {
    els.replyText.style.height = "auto";
    els.replyText.style.height = Math.min(160, els.replyText.scrollHeight) + "px";
  });

  state.saved = await browser.storage.local.get({
    convSortAsc: true,
    unreadFirst: true,
    markReadOnSelect: false,
    lastSelectedKey: null,
    convScrollTop: null,
    paneWidth: null,
  });
  state.sortAsc = Boolean(state.saved.convSortAsc);
  state.unreadFirst = Boolean(state.saved.unreadFirst);
  state.markReadOnSelect = Boolean(state.saved.markReadOnSelect);
  els.markReadOnSelect.checked = state.markReadOnSelect;
  updateSortButton();
  updateUnreadFirstButton();
  if (state.saved.paneWidth) {
    els.left.style.width = clampPaneWidth(state.saved.paneWidth) + "px";
  }

  registerLiveListeners();
  await loadAll();
}

function saveSession() {
  browser.storage.local.set({
    lastSelectedKey: state.selectedKey,
    convScrollTop: els.convList.scrollTop,
  });
}

/* ---------------- pane divider ---------------- */

function clampPaneWidth(w) {
  return Math.min(560, Math.max(240, w));
}

function initPaneDivider() {
  let dragging = false;
  els.divider.addEventListener("mousedown", (ev) => {
    dragging = true;
    ev.preventDefault();
    document.body.classList.add("resizing");
  });
  window.addEventListener("mousemove", (ev) => {
    if (!dragging) return;
    els.left.style.width = clampPaneWidth(ev.clientX) + "px";
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing");
    browser.storage.local.set({ paneWidth: parseInt(els.left.style.width, 10) });
  });
}

/* ---------------- data loading ---------------- */

async function loadAll() {
  if (state.loading) return;
  state.loading = true;
  els.refresh.classList.add("spinning");
  state.groups.clear();
  msgIndex.clear();
  state.totalMessages = 0;
  renderSenderList();
  renderConversation();
  setStatus("Finding folders…");

  try {
    const accounts = await browser.accounts.list();
    state.ownAddresses = new Set();
    for (const account of accounts) {
      for (const identity of account.identities || []) {
        if (identity.email) state.ownAddresses.add(identity.email.toLowerCase());
      }
    }

    const [inboxes, sents, junks] = await Promise.all([
      browser.folders.query({ specialUse: ["inbox"] }),
      browser.folders.query({ specialUse: ["sent"] }),
      browser.folders.query({ specialUse: ["junk"] }),
    ]);
    state.inboxFolderIds = new Set(inboxes.map((f) => f.id));
    state.sentFolderIds = new Set(sents.map((f) => f.id));
    state.junkFolderByAccount = new Map();
    for (const folder of junks) {
      if (folder.accountId) state.junkFolderByAccount.set(folder.accountId, folder.id);
    }
    const folderIds = [...state.inboxFolderIds, ...state.sentFolderIds];
    if (folderIds.length === 0) {
      setStatus("No Inbox or Sent folders found.");
      return;
    }

    setStatus("Loading messages…");
    let page = await browser.messages.query({
      folderId: folderIds,
      messagesPerPage: 500,
    });
    for (;;) {
      ingestPage(page.messages || []);
      renderSenderList();
      setStatus(`Loading… ${state.totalMessages} messages`);
      if (!page.id) break;
      page = await browser.messages.continueList(page.id);
    }

    renderSenderList();
    renderConversation();
    updateCountStatus();
    restoreSelection();
  } catch (e) {
    console.error("Sender View load failed:", e);
    setStatus(`Error: ${e.message}`);
  } finally {
    state.loading = false;
    els.refresh.classList.remove("spinning");
  }
}

function restoreSelection() {
  if (state.didRestore) return;
  state.didRestore = true;
  const key = state.saved.lastSelectedKey;
  if (key && state.groups.has(key)) {
    state.pendingScrollRestore =
      typeof state.saved.convScrollTop === "number" ? state.saved.convScrollTop : null;
    selectSender(key, { markRead: false });
  }
}

// Returns the set of group keys touched. Skips already-known message ids so
// live events can never double-ingest.
function ingestPage(headers) {
  const affected = new Set();
  for (const header of headers) {
    if (msgIndex.has(header.id)) continue;
    const date = new Date(header.date);
    const timestamp = date.getTime();
    const isSent = state.sentFolderIds.has(header.folder && header.folder.id);

    let counterparts;
    if (isSent) {
      const parsed = (header.recipients || []).flatMap(parseAddressList);
      const external = parsed.filter((p) => !state.ownAddresses.has(p.email));
      // A message sent only to yourself still deserves a home: file it
      // under your own address rather than dropping it.
      counterparts = external.length > 0 ? external : parsed;
    } else {
      counterparts = parseAddressList(header.author);
    }

    // Attribute the message at most once per group even if the same
    // address appears twice in the recipient list.
    const seen = new Set();
    for (const person of counterparts) {
      if (!person.email || seen.has(person.email)) continue;
      seen.add(person.email);
      addToGroup(person, header, isSent, timestamp);
      affected.add(person.email);
    }
    state.totalMessages++;
  }
  return affected;
}

function addToGroup(person, header, isSent, timestamp) {
  let group = state.groups.get(person.email);
  if (!group) {
    group = {
      key: person.email,
      email: person.email,
      name: person.name || person.email,
      nameTimestamp: person.name ? timestamp : -1,
      messages: [],
      unread: 0,
      latestTimestamp: -1,
      latestSubject: "",
    };
    state.groups.set(person.email, group);
  }

  const msg = {
    id: header.id,
    subject: header.subject || "(no subject)",
    timestamp,
    read: header.read !== false,
    isSent,
  };
  group.messages.push(msg);

  let indexEntries = msgIndex.get(header.id);
  if (!indexEntries) {
    indexEntries = [];
    msgIndex.set(header.id, indexEntries);
  }
  indexEntries.push({ group, msg });

  if (!msg.read && !isSent) group.unread++;

  if (person.name && timestamp >= group.nameTimestamp) {
    group.name = person.name;
    group.nameTimestamp = timestamp;
  }
  if (timestamp > group.latestTimestamp) {
    group.latestTimestamp = timestamp;
    group.latestSubject = msg.subject;
  }
}

// Removes a message everywhere it was attributed. Returns affected group keys.
function removeMessageById(id) {
  const entries = msgIndex.get(id);
  if (!entries) return [];
  msgIndex.delete(id);
  bodyCache.delete(id);
  audienceCache.delete(id);
  headerCache.delete(id);
  remoteAllowed.delete(id);
  state.expandedIds.delete(id);
  state.totalMessages--;
  if (state.replyTarget && state.replyTarget.id === id) {
    state.replyTarget = null;
    updateReplyChip();
  }

  const affected = [];
  for (const { group, msg } of entries) {
    const idx = group.messages.indexOf(msg);
    if (idx !== -1) group.messages.splice(idx, 1);
    if (!msg.read && !msg.isSent) group.unread--;
    affected.push(group.key);
    if (group.messages.length === 0) {
      state.groups.delete(group.key);
      if (state.selectedKey === group.key) state.selectedKey = null;
    } else {
      recomputeGroupMeta(group);
    }
  }
  return affected;
}

function recomputeGroupMeta(group) {
  let latest = null;
  for (const msg of group.messages) {
    if (!latest || msg.timestamp > latest.timestamp) latest = msg;
  }
  group.latestTimestamp = latest ? latest.timestamp : -1;
  group.latestSubject = latest ? latest.subject : "";
}

/* ---------------- read/unread actions ---------------- */

// Optimistic local application; safe to call again when the onUpdated echo
// arrives (no-ops once state matches).
function applyReadState(id, read) {
  const entries = msgIndex.get(id);
  if (!entries) return;
  let touchedSelected = false;
  for (const { group, msg } of entries) {
    if (msg.read === read) continue;
    msg.read = read;
    if (!msg.isSent) group.unread += read ? -1 : 1;
    if (group.key === state.selectedKey) touchedSelected = true;
  }
  if (touchedSelected) patchConversationReadState(id, read);
  scheduleRender({ sender: true });
}

function patchConversationReadState(id, read) {
  const group = state.groups.get(state.selectedKey);
  for (const row of els.convList.querySelectorAll(`.msg-row[data-msg-id="${id}"]`)) {
    row.classList.toggle("unread", !read);
    const toggle = row.querySelector(".msg-read-btn");
    if (toggle) decorateReadButton(toggle, read);
  }
  if (group) updateConvHeaderCounts(group);
}

async function setRead(id, read) {
  applyReadState(id, read);
  try {
    await browser.messages.update(id, { read });
  } catch (e) {
    console.error("messages.update failed:", e);
    setStatus(`Could not update read state: ${e.message}`);
  }
}

async function markAllRead() {
  const group = state.groups.get(state.selectedKey);
  if (!group) return;
  const ids = [...new Set(
    group.messages.filter((m) => !m.isSent && !m.read).map((m) => m.id)
  )];
  for (const id of ids) applyReadState(id, true);

  // Small concurrency pool so a 500-message backlog doesn't fire at once.
  const queue = [...ids];
  const worker = async () => {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return;
      try {
        await browser.messages.update(id, { read: true });
      } catch (e) {
        console.error("messages.update failed for", id, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker));
}

/* ---------------- archive / delete / spam actions ---------------- */

// All actions are recoverable: delete moves to Trash (never permanent),
// spam moves to the account's Junk folder, archive uses account settings.
// UI removal is event-driven via the onMoved/onDeleted listeners.

const bulkBusy = new Set(); // sender keys with a bulk action in flight

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function archiveMessages(ids) {
  for (const part of chunkArray(ids, 100)) {
    await browser.messages.archive(part);
  }
}

async function deleteMessages(ids) {
  for (const part of chunkArray(ids, 100)) {
    await browser.messages.delete(part, { isUserAction: true });
  }
}

// Flags as junk (feeds Thunderbird's junk classification), then moves to the
// owning account's Junk folder. Returns how many could not be moved because
// their account has no Junk folder (they stay in place, flagged).
async function spamMessages(ids) {
  const queue = [...ids];
  const worker = async () => {
    for (;;) {
      const id = queue.shift();
      if (id === undefined) return;
      try {
        await browser.messages.update(id, { junk: true });
      } catch (e) {
        console.error("junk flag failed for", id, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, ids.length) }, worker));

  const byJunkFolder = new Map();
  let unmovable = 0;
  for (const id of ids) {
    const header = await fetchFullHeader(id);
    const accountId = header && header.folder ? header.folder.accountId : null;
    const junkFolderId = accountId ? state.junkFolderByAccount.get(accountId) : null;
    if (!junkFolderId) {
      unmovable++;
      continue;
    }
    if (!byJunkFolder.has(junkFolderId)) byJunkFolder.set(junkFolderId, []);
    byJunkFolder.get(junkFolderId).push(id);
  }
  for (const [folderId, folderIds] of byJunkFolder) {
    for (const part of chunkArray(folderIds, 100)) {
      try {
        await browser.messages.move(part, folderId, { isUserAction: true });
      } catch (e) {
        // Thunderbird's junk filter may already have moved some of them,
        // invalidating their ids; the onMoved listener handles the fallout.
        console.warn("junk move failed (possibly already moved):", e);
      }
    }
  }
  return unmovable;
}

const ACTION_LABELS = {
  archive: ["Archiving", "Archived"],
  delete: ["Deleting", "Deleted"],
  spam: ["Marking as spam", "Marked as spam:"],
};

async function runAction(kind, ids, senderName) {
  const plural = ids.length === 1 ? "message" : "messages";
  setStatus(`${ACTION_LABELS[kind][0]} ${ids.length} ${plural}…`);
  try {
    let note = "";
    if (kind === "archive") await archiveMessages(ids);
    else if (kind === "delete") await deleteMessages(ids);
    else {
      const unmovable = await spamMessages(ids);
      if (unmovable > 0) note = ` (${unmovable} flagged only — account has no Junk folder)`;
    }
    const from = senderName ? ` from ${senderName}` : "";
    setStatus(`${ACTION_LABELS[kind][1]} ${ids.length} ${plural}${from}${note}`);
  } catch (e) {
    console.error(`${kind} failed:`, e);
    setStatus(`${kind[0].toUpperCase()}${kind.slice(1)} failed: ${e.message}`);
  }
}

const BULK_CONFIRM = {
  archive: (n, s, name) => `Archive ${n} received message${s} from ${name}?`,
  delete: (n, s, name) => `Delete ${n} received message${s} from ${name}?\n\nThey will be moved to Trash.`,
  spam: (n, s, name) => `Mark ${n} received message${s} from ${name} as spam?\n\nThey will be moved to the Junk folder.`,
};

async function bulkAction(key, kind) {
  if (bulkBusy.has(key)) return;
  const group = state.groups.get(key);
  if (!group) return;
  const ids = [...new Set(group.messages.filter((m) => !m.isSent).map((m) => m.id))];
  if (ids.length === 0) {
    setStatus("This sender has no received messages to act on.");
    return;
  }
  const s = ids.length === 1 ? "" : "s";
  if (!window.confirm(BULK_CONFIRM[kind](ids.length, s, group.name))) return;
  bulkBusy.add(key);
  try {
    await runAction(kind, ids, group.name);
  } finally {
    bulkBusy.delete(key);
  }
}

function makeActionButton(className, glyph, title, handler) {
  const btn = document.createElement("button");
  btn.className = className;
  btn.textContent = glyph;
  btn.title = title;
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    handler();
  });
  return btn;
}

/* ---------------- live update events ---------------- */

function registerLiveListeners() {
  const m = browser.messages;
  if (m.onNewMailReceived) m.onNewMailReceived.addListener(onNewMail);
  if (m.onUpdated) m.onUpdated.addListener(onMsgUpdated);
  if (m.onMoved) m.onMoved.addListener(onMsgMoved);
  if (m.onCopied) m.onCopied.addListener(onMsgCopied);
  if (m.onDeleted) m.onDeleted.addListener(onMsgDeleted);
  // Belt-and-braces for sent copies: onCopied/onMoved usually deliver them,
  // but the send pipeline reports its own Sent-folder copies too.
  if (browser.compose && browser.compose.onAfterSend) {
    browser.compose.onAfterSend.addListener(onAfterSend);
  }
}

function onAfterSend(tab, sendInfo) {
  try {
    const landed = (sendInfo.messages || []).filter((h) => folderInScope(h.folder));
    const added = ingestPage(landed);
    if (added.size > 0) {
      scheduleRender({ sender: true, conv: added.has(state.selectedKey) });
    }
  } catch (e) {
    console.error("onAfterSend handling failed:", e);
  }
}

function folderInScope(folder) {
  const id = folder && folder.id;
  return state.inboxFolderIds.has(id) || state.sentFolderIds.has(id);
}

async function drainMessageList(messageList) {
  const headers = [...(messageList.messages || [])];
  let listId = messageList.id;
  while (listId) {
    const page = await browser.messages.continueList(listId);
    headers.push(...(page.messages || []));
    listId = page.id;
  }
  return headers;
}

async function onNewMail(folder, messageList) {
  if (!folderInScope(folder)) return;
  try {
    const headers = await drainMessageList(messageList);
    const affected = ingestPage(headers);
    if (affected.size > 0) {
      scheduleRender({ sender: true, conv: affected.has(state.selectedKey) });
    }
  } catch (e) {
    console.error("onNewMail handling failed:", e);
  }
}

function onMsgUpdated(header, changedProperties) {
  if (changedProperties && typeof changedProperties.read === "boolean") {
    applyReadState(header.id, changedProperties.read);
  }
}

async function onMsgMoved(originalMessages, movedMessages) {
  try {
    const removed = (await drainMessageList(originalMessages))
      .flatMap((h) => removeMessageById(h.id));
    const landed = (await drainMessageList(movedMessages))
      .filter((h) => folderInScope(h.folder));
    const added = ingestPage(landed);
    const keys = new Set([...removed, ...added]);
    if (keys.size > 0) {
      scheduleRender({ sender: true, conv: keys.has(state.selectedKey) || state.selectedKey === null });
    }
  } catch (e) {
    console.error("onMoved handling failed:", e);
  }
}

async function onMsgCopied(originalMessages, copiedMessages) {
  try {
    const landed = (await drainMessageList(copiedMessages))
      .filter((h) => folderInScope(h.folder));
    const added = ingestPage(landed);
    if (added.size > 0) {
      scheduleRender({ sender: true, conv: added.has(state.selectedKey) });
    }
  } catch (e) {
    console.error("onCopied handling failed:", e);
  }
}

async function onMsgDeleted(messageList) {
  try {
    const removed = (await drainMessageList(messageList))
      .flatMap((h) => removeMessageById(h.id));
    if (removed.length > 0) {
      const keys = new Set(removed);
      scheduleRender({ sender: true, conv: keys.has(state.selectedKey) || state.selectedKey === null });
    }
  } catch (e) {
    console.error("onDeleted handling failed:", e);
  }
}

/* ---------------- render scheduling ---------------- */

const renderQueue = { sender: false, conv: false, timer: null };

function scheduleRender({ sender = false, conv = false } = {}) {
  renderQueue.sender = renderQueue.sender || sender;
  renderQueue.conv = renderQueue.conv || conv;
  if (renderQueue.timer) return;
  renderQueue.timer = setTimeout(() => {
    renderQueue.timer = null;
    const doSender = renderQueue.sender;
    const doConv = renderQueue.conv;
    renderQueue.sender = renderQueue.conv = false;
    if (doSender) {
      renderSenderList();
      if (!state.loading) updateCountStatus();
    }
    if (doConv) renderConversation({ mode: "preserve" });
  }, 250);
}

function updateCountStatus() {
  setStatus(`${state.groups.size} senders · ${state.totalMessages} messages`);
}

/* ---------------- address parsing ---------------- */

// Splits a header-style address string ("A <a@x>, \"B, Jr.\" <b@y>") into
// parts, respecting quotes and angle brackets, then parses each part.
function parseAddressList(raw) {
  if (!raw) return [];
  const parts = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;
  for (const ch of raw) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (ch === "<" && !inQuotes) inAngle = true;
    else if (ch === ">" && !inQuotes) inAngle = false;
    if (ch === "," && !inQuotes && !inAngle) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map(parseAddress).filter((p) => p !== null);
}

function parseAddress(raw) {
  const str = raw.trim();
  if (!str) return null;
  const match = str.match(/^"?([^"]*)"?\s*<([^<>]+)>$/);
  if (match) {
    return {
      name: match[1].trim(),
      email: match[2].trim().toLowerCase(),
    };
  }
  // Bare address, possibly wrapped in angle brackets.
  const bare = str.replace(/^<|>$/g, "").trim();
  if (bare.includes("@")) {
    return { name: "", email: bare.toLowerCase() };
  }
  // A display name with no parsable address (rare); skip it.
  return null;
}

/* ---------------- body fetching + caching ---------------- */

async function fetchBody(messageId) {
  if (bodyCache.has(messageId)) return bodyCache.get(messageId);

  const entry = { html: null, text: null, attachments: [], snippet: null, error: null };
  try {
    const parts = await browser.messages.listInlineTextParts(messageId);
    for (const part of parts || []) {
      const type = (part.contentType || "").toLowerCase();
      if (type.includes("text/html") && entry.html === null) entry.html = part.content;
      else if (type.includes("text/plain") && entry.text === null) entry.text = part.content;
    }
  } catch (e) {
    entry.error = e.message;
  }
  try {
    entry.attachments = (await browser.messages.listAttachments(messageId)) || [];
  } catch (e) {
    // Not fatal; some message types have no attachment listing.
  }
  if (entry.html === null && entry.text === null && !entry.error) {
    entry.error = "No readable content found";
  }

  if (bodyCache.size >= BODY_CACHE_MAX) {
    // Drop the oldest third of the cache (Map preserves insertion order).
    let toDrop = Math.floor(BODY_CACHE_MAX / 3);
    for (const key of bodyCache.keys()) {
      if (toDrop-- <= 0) break;
      bodyCache.delete(key);
    }
  }
  bodyCache.set(messageId, entry);
  return entry;
}

async function snippetFor(messageId) {
  const entry = await fetchBody(messageId);
  if (entry.snippet !== null) return entry.snippet;

  let text = entry.text;
  if (!text && entry.html) {
    try {
      text = await browser.messengerUtilities.convertToPlainText(entry.html);
    } catch (e) {
      // Fallback: strip tags locally. DOMParser does not execute content.
      const doc = new DOMParser().parseFromString(entry.html, "text/html");
      text = doc.body ? doc.body.textContent : "";
    }
  }
  const snippet = (text || "").replace(/\s+/g, " ").trim().slice(0, 160);
  entry.snippet = snippet;
  return snippet;
}

/* ---------------- HTML sanitizing + sandboxed rendering ---------------- */

const BLOCKED_TAGS = "script,link,object,embed,iframe,frame,form,meta,base,audio,video,applet";
const URL_ATTRS = ["src", "srcset", "poster", "background"];

// Sanitizes message HTML. Scripts, event handlers and javascript: URLs are
// always stripped. Remote resource URLs are stripped by default; with
// allowRemote=true (explicit per-message user opt-in) they stay and the CSP
// permits image loads — nothing else.
function sanitizeHtml(html, allowRemote = false) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll(BLOCKED_TAGS).forEach((el) => el.remove());

  let blockedCount = 0;
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
      } else if ((name === "href" || name === "xlink:href") && /^\s*(javascript|data):/i.test(value)) {
        el.removeAttribute(attr.name);
      } else if (URL_ATTRS.includes(name) && /^\s*(https?:)?\/\//i.test(value)) {
        if (allowRemote) continue;
        blockedCount++;
        // Remote resource: neutralize but keep the original for debugging.
        el.setAttribute("data-blocked-" + name, value);
        el.removeAttribute(attr.name);
      }
    }
  }

  // CSP backstop: even if the sweep above misses something, the document
  // itself refuses remote loads (images only when the user opted in).
  const imgSrc = allowRemote ? "data: cid: https: http:" : "data: cid:";
  const csp = doc.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", `default-src 'none'; style-src 'unsafe-inline'; img-src ${imgSrc};`);
  doc.head.insertBefore(csp, doc.head.firstChild);

  // Readability defaults; HTML mail assumes a white canvas, so force one
  // (matches Thunderbird's own reader in dark theme).
  const style = doc.createElement("style");
  style.textContent =
    "body{margin:8px;font:13px system-ui,-apple-system,'Segoe UI',sans-serif;" +
    "color:#1b1d21;background:#ffffff;overflow-wrap:break-word;}" +
    "img{max-width:100%;height:auto;}";
  doc.head.appendChild(style);

  return {
    html: "<!DOCTYPE html>" + doc.documentElement.outerHTML,
    blockedCount,
  };
}

// Takes already-sanitized HTML (output of sanitizeHtml).
function buildBodyFrame(sanitizedHtml, onSized) {
  const iframe = document.createElement("iframe");
  iframe.className = "msg-frame";
  // No allow-scripts: content is inert, so same-origin access (needed for
  // auto-sizing and link handling) is safe.
  iframe.setAttribute("sandbox", "allow-same-origin");
  iframe.srcdoc = sanitizedHtml;
  iframe.addEventListener("load", () => {
    try {
      const doc = iframe.contentDocument;
      const height = Math.min(Math.max(doc.body.scrollHeight + 20, 40), 1400);
      iframe.style.height = height + "px";
      doc.addEventListener(
        "click",
        (ev) => {
          const link = ev.target && ev.target.closest ? ev.target.closest("a[href]") : null;
          if (!link) return;
          ev.preventDefault();
          const href = link.getAttribute("href") || "";
          if (/^https?:/i.test(href)) {
            browser.windows.openDefaultBrowser(href).catch((e) =>
              console.warn("openDefaultBrowser failed:", e)
            );
          }
        },
        true
      );
    } catch (e) {
      console.warn("iframe post-load setup failed:", e);
    }
    if (onSized) onSized();
  });
  return iframe;
}

/* ---------------- sender list rendering ---------------- */

function renderSenderList() {
  const gen = ++state.listRenderGen;
  const filter = state.filterText;

  let entries = [...state.groups.values()];
  if (filter) {
    entries = entries.filter(
      (g) => g.name.toLowerCase().includes(filter) || g.email.includes(filter)
    );
  }
  entries.sort((a, b) => {
    if (state.unreadFirst) {
      const aUnread = a.unread > 0 ? 1 : 0;
      const bUnread = b.unread > 0 ? 1 : 0;
      if (aUnread !== bUnread) return bUnread - aUnread;
    }
    return b.latestTimestamp - a.latestTimestamp;
  });

  els.senderList.textContent = "";
  const CHUNK = 250;
  let index = 0;

  const renderChunk = () => {
    if (gen !== state.listRenderGen) return; // superseded by a newer render
    const fragment = document.createDocumentFragment();
    const end = Math.min(index + CHUNK, entries.length);
    for (; index < end; index++) {
      fragment.appendChild(buildSenderRow(entries[index]));
    }
    els.senderList.appendChild(fragment);
    if (index < entries.length) requestAnimationFrame(renderChunk);
  };
  renderChunk();
}

function buildSenderRow(group) {
  const row = document.createElement("div");
  row.className = "sender-row";
  row.dataset.key = group.key;
  if (group.unread > 0) row.classList.add("unread");
  if (group.key === state.selectedKey) row.classList.add("selected");
  row.addEventListener("click", () => selectSender(group.key));

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = initialsFor(group.name);

  const main = document.createElement("div");
  main.className = "sender-main";

  const line1 = document.createElement("div");
  line1.className = "sender-line1";
  const name = document.createElement("span");
  name.className = "sender-name";
  name.textContent = group.name;
  const time = document.createElement("span");
  time.className = "sender-time";
  time.textContent = formatListTime(group.latestTimestamp);
  line1.append(name, time);

  const email = document.createElement("div");
  email.className = "sender-email";
  email.textContent = group.email;

  const line3 = document.createElement("div");
  line3.className = "sender-line3";
  const subject = document.createElement("span");
  subject.className = "sender-subject";
  subject.textContent = group.latestSubject;
  const badges = document.createElement("span");
  badges.className = "sender-badges";
  if (group.unread > 0) {
    const unreadBadge = document.createElement("span");
    unreadBadge.className = "badge unread-badge";
    unreadBadge.textContent = String(group.unread);
    badges.appendChild(unreadBadge);
  }
  const countBadge = document.createElement("span");
  countBadge.className = "badge";
  countBadge.textContent = String(group.messages.length);
  badges.appendChild(countBadge);

  const rowActions = document.createElement("span");
  rowActions.className = "sender-actions";
  rowActions.append(
    makeActionButton("sender-action-btn", "📦",
      "Archive all received messages from this sender",
      () => bulkAction(group.key, "archive")),
    makeActionButton("sender-action-btn", "🚫",
      "Mark all received messages from this sender as spam",
      () => bulkAction(group.key, "spam")),
    makeActionButton("sender-action-btn", "🗑",
      "Delete all received messages from this sender (moves to Trash)",
      () => bulkAction(group.key, "delete"))
  );

  line3.append(subject, badges, rowActions);

  main.append(line1, email, line3);
  row.append(avatar, main);
  return row;
}

function selectSender(key, { markRead = state.markReadOnSelect } = {}) {
  if (state.selectedKey && state.selectedKey !== key) {
    stashDraft();
  }
  state.selectedKey = key;
  state.replyTarget = null;
  state.expandedIds = new Set();
  state.expandInit = false;
  state.convLimit = CONV_PAGE;
  for (const row of els.senderList.children) {
    row.classList.toggle("selected", row.dataset.key === key);
  }
  browser.storage.local.set({ lastSelectedKey: key });
  renderConversation({ markRead });
}

/* ---------------- conversation rendering ---------------- */

function renderConversation(opts = {}) {
  const mode = opts.mode || "initial";
  const prevTop = els.convList.scrollTop;
  const prevHeight = els.convList.scrollHeight;
  const wasAtBottom =
    prevTop + els.convList.clientHeight >= prevHeight - 12;

  snippetObserver.disconnect();
  const group = state.selectedKey ? state.groups.get(state.selectedKey) : null;

  if (!group) {
    els.convHeader.hidden = true;
    els.replyBar.hidden = true;
    els.convList.textContent = "";
    els.convEmpty.classList.remove("hidden");
    return;
  }

  els.convHeader.hidden = false;
  els.convEmpty.classList.add("hidden");
  els.convName.textContent = group.name;
  els.convEmail.textContent = group.email;
  updateConvHeaderCounts(group);

  els.replyBar.hidden = false;
  els.replyText.placeholder = `Reply to ${group.name} — Ctrl+Enter to send`;
  if (state.replyDraftKey !== group.key) {
    state.replyDraftKey = group.key;
    els.replyText.value = drafts.get(group.key) || "";
    els.replyText.style.height = "auto";
  }
  updateReplyChip();

  const all = [...group.messages].sort((a, b) =>
    state.sortAsc ? a.timestamp - b.timestamp : b.timestamp - a.timestamp
  );

  // First render for this sender: auto-expand the newest message.
  // Only explicit sender selection can mark it read, when opted in.
  if (!state.expandInit && all.length > 0) {
    const newest = all.reduce((a, b) => (b.timestamp > a.timestamp ? b : a));
    state.expandedIds.add(newest.id);
    state.expandInit = true;
    if (opts.markRead && !newest.isSent && !newest.read) {
      setRead(newest.id, true);
    }
  }

  // Only the newest convLimit messages are rendered; older ones sit behind
  // a "show older" row at the old end of the list.
  const hiddenCount = Math.max(0, all.length - state.convLimit);
  const visible = hiddenCount === 0
    ? all
    : state.sortAsc
      ? all.slice(hiddenCount)
      : all.slice(0, state.convLimit);

  els.convList.textContent = "";
  const fragment = document.createDocumentFragment();
  const olderRow = hiddenCount > 0 ? buildOlderRow(hiddenCount) : null;
  if (olderRow && state.sortAsc) fragment.appendChild(olderRow);
  for (const msg of visible) {
    fragment.appendChild(buildMessageRow(msg, group));
  }
  if (olderRow && !state.sortAsc) fragment.appendChild(olderRow);
  els.convList.appendChild(fragment);

  if (state.pendingScrollRestore !== null) {
    els.convList.scrollTop = state.pendingScrollRestore;
    state.pendingScrollRestore = null;
  } else if (mode === "anchor") {
    // Older messages were prepended (asc) or appended (desc); keep viewport.
    els.convList.scrollTop = state.sortAsc
      ? prevTop + (els.convList.scrollHeight - prevHeight)
      : prevTop;
  } else if (mode === "preserve") {
    if (state.sortAsc && wasAtBottom) scrollToNewest();
    else els.convList.scrollTop = prevTop;
  } else {
    scrollToNewest();
  }
  primeVisibleSnippets();
}

function updateConvHeaderCounts(group) {
  els.convCount.textContent =
    group.messages.length === 1 ? "1 message" : `${group.messages.length} messages`;
  els.markAllRead.hidden = group.unread === 0;
  if (group.unread > 0) {
    els.markAllRead.textContent = `Mark all read (${group.unread})`;
  }
}

function buildOlderRow(hiddenCount) {
  const row = document.createElement("div");
  row.className = "older-row";
  row.textContent = `Show ${Math.min(CONV_PAGE, hiddenCount)} older messages (${hiddenCount} hidden)`;
  row.addEventListener("click", loadOlder);
  return row;
}

function loadOlder() {
  if (state.loadingOlder) return;
  state.loadingOlder = true;
  state.convLimit += CONV_PAGE;
  renderConversation({ mode: "anchor" });
  state.loadingOlder = false;
}

function maybeAutoLoadOlder() {
  const group = state.selectedKey ? state.groups.get(state.selectedKey) : null;
  if (!group || group.messages.length <= state.convLimit) return;
  const list = els.convList;
  const nearOldEnd = state.sortAsc
    ? list.scrollTop < 150
    : list.scrollTop + list.clientHeight > list.scrollHeight - 150;
  if (nearOldEnd) loadOlder();
}

function scrollToNewest() {
  // Newest message into view: bottom when ascending, top when descending.
  els.convList.scrollTop = state.sortAsc ? els.convList.scrollHeight : 0;
}

// Loads snippets for collapsed bubbles currently in (or near) view. The
// IntersectionObserver handles the rest during scrolling; this covers the
// initial render and environments where observer callbacks are delayed.
function primeVisibleSnippets() {
  const rootRect = els.convList.getBoundingClientRect();
  for (const el of els.convList.querySelectorAll(".msg-snippet")) {
    if (el.dataset.loading) continue;
    const rect = el.getBoundingClientRect();
    if (rect.bottom >= rootRect.top - 300 && rect.top <= rootRect.bottom + 300) {
      snippetObserver.unobserve(el);
      loadSnippet(el);
    }
  }
}

function decorateReadButton(btn, read) {
  btn.textContent = read ? "✉" : "✓";
  btn.title = read ? "Mark as unread" : "Mark as read";
}

function buildMessageRow(msg, group) {
  const expanded = state.expandedIds.has(msg.id);

  const row = document.createElement("div");
  row.className = "msg-row";
  row.dataset.msgId = String(msg.id);
  if (msg.isSent) row.classList.add("sent");
  if (!msg.read && !msg.isSent) row.classList.add("unread");
  if (expanded) row.classList.add("expanded");

  const head = document.createElement("div");
  head.className = "msg-head";

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const dir = document.createElement("span");
  dir.className = "msg-dir";
  dir.textContent = msg.isSent ? "You" : group.name;
  const when = document.createElement("span");
  when.textContent = new Date(msg.timestamp).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
  meta.append(dir, when);

  const actions = document.createElement("span");
  actions.className = "msg-actions";

  const replyBtn = document.createElement("button");
  replyBtn.className = "msg-reply-btn";
  replyBtn.textContent = "↩";
  replyBtn.title = msg.isSent
    ? "Reply to this message (goes to its original recipients)"
    : "Reply to this message";
  replyBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    setReplyTarget(msg);
    els.replyText.focus();
    if (!msg.isSent && !msg.read) setRead(msg.id, true);
  });
  actions.appendChild(replyBtn);

  if (!msg.isSent) {
    const readBtn = document.createElement("button");
    readBtn.className = "msg-read-btn";
    decorateReadButton(readBtn, msg.read);
    readBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      setRead(msg.id, !msg.read);
    });
    actions.appendChild(readBtn);
  }

  const openBtn = document.createElement("button");
  openBtn.className = "msg-open-btn";
  openBtn.textContent = "↗";
  openBtn.title = "Open in Thunderbird reader";
  openBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openMessage(msg.id);
  });
  actions.appendChild(openBtn);

  actions.appendChild(makeActionButton("msg-open-btn", "📦", "Archive this message",
    () => runAction("archive", [msg.id])));
  if (!msg.isSent) {
    actions.appendChild(makeActionButton("msg-open-btn", "🚫", "Mark as spam (moves to Junk)",
      () => runAction("spam", [msg.id])));
  }
  actions.appendChild(makeActionButton("msg-open-btn", "🗑", "Delete this message (moves to Trash)",
    () => runAction("delete", [msg.id])));

  head.append(meta, actions);

  const subject = document.createElement("div");
  subject.className = "msg-subject";
  subject.textContent = msg.subject;

  row.append(head, subject);

  if (expanded) {
    const body = document.createElement("div");
    body.className = "msg-body";
    row.appendChild(body);
    renderBodyInto(body, msg);
    // Collapse via the header only, so text in the body stays selectable.
    head.addEventListener("click", () => toggleExpand(msg, row, group));
    head.title = "Collapse";
  } else {
    const snippet = document.createElement("div");
    snippet.className = "msg-snippet";
    snippet.dataset.msgId = String(msg.id);
    row.appendChild(snippet);
    snippetObserver.observe(snippet);
    row.title = "Click to expand";
    row.addEventListener("click", () => toggleExpand(msg, row, group));
  }

  return row;
}

function toggleExpand(msg, row, group) {
  const expanding = !state.expandedIds.has(msg.id);
  if (expanding) state.expandedIds.add(msg.id);
  else state.expandedIds.delete(msg.id);
  const replacement = buildMessageRow(msg, group);
  row.replaceWith(replacement);
  // Deliberate expansion of an unread received message marks it read.
  // (The automatic newest-message expansion does not go through here.)
  if (expanding && !msg.isSent && !msg.read) {
    setRead(msg.id, true);
  }
}

function buildHeadersBlock(header) {
  const rows = [
    ["From", header.author ? [header.author] : []],
    ["To", header.recipients || []],
    ["Cc", header.ccList || []],
    ["Bcc", header.bccList || []],
  ];
  const block = document.createElement("div");
  block.className = "msg-headers";
  let any = false;
  for (const [label, values] of rows) {
    if (values.length === 0) continue;
    any = true;
    const labelEl = document.createElement("div");
    labelEl.className = "hdr-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("div");
    valueEl.className = "hdr-value";
    valueEl.textContent = values.join(", ");
    block.append(labelEl, valueEl);
  }
  return any ? block : null;
}

async function renderBodyInto(container, msg) {
  container.textContent = "Loading…";
  container.classList.add("loading");
  const [entry, fullHeader] = await Promise.all([
    fetchBody(msg.id),
    fetchFullHeader(msg.id),
  ]);
  container.classList.remove("loading");

  // Body content arriving asynchronously grows the list; keep a
  // bottom-pinned chat view pinned through the mutation (and through the
  // later iframe auto-size).
  const list = els.convList;
  const wasPinned =
    state.sortAsc && list.scrollTop + list.clientHeight >= list.scrollHeight - 12;
  const restick = wasPinned ? () => { list.scrollTop = list.scrollHeight; } : null;

  container.textContent = "";

  if (fullHeader) {
    const headersBlock = buildHeadersBlock(fullHeader);
    if (headersBlock) container.appendChild(headersBlock);
  }

  if (entry.html) {
    const allow = remoteAllowed.has(msg.id);
    const { html: safeHtml, blockedCount } = sanitizeHtml(entry.html, allow);
    if (!allow && blockedCount > 0) {
      const banner = document.createElement("div");
      banner.className = "remote-banner";
      const label = document.createElement("span");
      label.textContent = `🖼 ${blockedCount} remote ${blockedCount === 1 ? "resource" : "resources"} blocked to protect your privacy.`;
      const loadBtn = document.createElement("button");
      loadBtn.textContent = "Load remote content";
      loadBtn.title = "Load remote images for this message only (may signal the sender that you opened it)";
      loadBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        remoteAllowed.add(msg.id);
        renderBodyInto(container, msg);
      });
      banner.append(label, loadBtn);
      container.appendChild(banner);
    }
    container.appendChild(buildBodyFrame(safeHtml, restick));
  } else if (entry.text !== null) {
    const div = document.createElement("div");
    div.className = "msg-text";
    div.textContent = entry.text;
    container.appendChild(div);
  } else {
    const err = document.createElement("div");
    err.className = "msg-error";
    err.textContent = `Could not load content (${entry.error}). `;
    const link = document.createElement("a");
    link.href = "#";
    link.textContent = "Open in reader";
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      openMessage(msg.id);
    });
    err.appendChild(link);
    container.appendChild(err);
  }

  if (entry.attachments.length > 0) {
    const strip = document.createElement("div");
    strip.className = "attachments";
    for (const att of entry.attachments) {
      const chip = document.createElement("span");
      chip.className = "attachment-chip";
      chip.textContent = `📎 ${att.name || "attachment"} · ${formatSize(att.size)}`;
      chip.title = "Open message in Thunderbird reader to access attachments";
      chip.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openMessage(msg.id);
      });
      strip.appendChild(chip);
    }
    container.appendChild(strip);
  }

  if (restick) restick();
}

async function loadSnippet(el) {
  if (el.dataset.loading) return;
  el.dataset.loading = "1";
  const messageId = Number(el.dataset.msgId);
  try {
    const snippet = await snippetFor(messageId);
    if (!el.isConnected) return;
    const list = els.convList;
    const wasAtBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 12;
    el.textContent = snippet;
    // Filling text grows the list; don't let that pull a bottom-pinned
    // chat view away from the newest message.
    if (state.sortAsc && wasAtBottom) list.scrollTop = list.scrollHeight;
  } catch (e) {
    // Snippets are decorative; stay silent on failure.
  }
}

async function openMessage(messageId) {
  try {
    await browser.messageDisplay.open({ messageId, location: "tab" });
  } catch (e) {
    console.error("Failed to open message:", e);
    setStatus(`Could not open message: ${e.message}`);
  }
}

/* ---------------- quick reply / compose ---------------- */

function stashDraft() {
  if (state.replyDraftKey) {
    const text = els.replyText.value;
    if (text.trim()) drafts.set(state.replyDraftKey, text);
    else drafts.delete(state.replyDraftKey);
  }
}

// The newest received message is the natural reply anchor.
function findReplyTarget(group) {
  let target = null;
  for (const msg of group.messages) {
    if (msg.isSent) continue;
    if (!target || msg.timestamp > target.timestamp) target = msg;
  }
  return target;
}

function currentReplyTarget(group) {
  return state.replyTarget || findReplyTarget(group);
}

function setReplyTarget(msg) {
  state.replyTarget = msg;
  updateReplyChip();
}

// Full MessageHeader (author, recipients, ccList, bccList) — shared by the
// reply-chip audience preview and the expanded-message header block.
async function fetchFullHeader(id) {
  if (headerCache.has(id)) return headerCache.get(id);
  let header = null;
  try {
    header = await browser.messages.get(id);
  } catch (e) {
    console.warn("messages.get failed:", e);
  }
  headerCache.set(id, header);
  return header;
}

// Preview of Thunderbird's reply-all audience for a message: everyone in
// From/To/CC except our own identities. Thunderbird's own logic is
// authoritative at send time; this is the visible warning surface.
async function audienceFor(msg) {
  if (audienceCache.has(msg.id)) return audienceCache.get(msg.id);
  let people = null;
  const header = await fetchFullHeader(msg.id);
  if (header) {
    const raw = msg.isSent
      ? [...(header.recipients || []), ...(header.ccList || [])]
      : [header.author, ...(header.recipients || []), ...(header.ccList || [])];
    const seen = new Set();
    people = [];
    for (const person of raw.flatMap(parseAddressList)) {
      if (!person.email || seen.has(person.email)) continue;
      if (state.ownAddresses.has(person.email)) continue;
      seen.add(person.email);
      people.push(person);
    }
  }
  audienceCache.set(msg.id, people);
  return people;
}

// Keeps the always-visible chip in sync: what the quick reply will answer
// and who will receive it. `.multi` warns when more than one person will.
async function updateReplyChip() {
  const gen = ++state.chipGen;
  const group = state.groups.get(state.selectedKey);

  const previous = els.convList.querySelector(".msg-row.reply-targeted");
  if (previous) previous.classList.remove("reply-targeted");
  els.replyChipClear.hidden = !state.replyTarget;
  els.replyChip.classList.remove("multi");
  els.replyChip.title = "";

  if (!group) {
    els.replyChipText.textContent = "";
    return;
  }

  const target = currentReplyTarget(group);
  if (!target) {
    els.replyChipText.textContent = `New message to ${group.name}`;
    return;
  }

  if (state.replyTarget) {
    const row = els.convList.querySelector(`.msg-row[data-msg-id="${target.id}"]`);
    if (row) row.classList.add("reply-targeted");
  }

  const base = `↩ Replying to: “${target.subject}”`;
  els.replyChipText.textContent = base;

  const people = await audienceFor(target);
  if (gen !== state.chipGen) return; // target changed while we were looking up
  if (people && people.length > 0) {
    const names = people.slice(0, 2).map((p) => p.name || p.email);
    const extra = people.length > 2 ? ` +${people.length - 2}` : "";
    els.replyChipText.textContent = `${base} → ${names.join(", ")}${extra}`;
    if (people.length > 1) {
      els.replyChip.classList.add("multi");
      els.replyChip.title =
        `This reply will go to ${people.length} people. ` +
        "Use Full compose to change the recipients.";
    }
  }
}

function replySubjectFor(group) {
  const subject = group.latestSubject || "";
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`.trim();
}

// Opens a compose tab replying to the current target (an explicitly chosen
// message, else the newest received one), otherwise a new message.
async function beginComposeFor(group) {
  const target = currentReplyTarget(group);
  if (target) {
    return browser.compose.beginReply(target.id, "replyToAll");
  }
  return browser.compose.beginNew({
    to: group.name && group.name !== group.email
      ? `${group.name} <${group.email}>`
      : group.email,
    subject: replySubjectFor(group),
  });
}

// Places the typed text above whatever the compose window already contains
// (the quoted original for replies). User text is inserted as text nodes —
// never as markup.
async function injectReplyText(tabId, text) {
  const details = await browser.compose.getComposeDetails(tabId);
  if (details.isPlainText) {
    const existing = details.plainTextBody || "";
    await browser.compose.setComposeDetails(tabId, {
      plainTextBody: existing ? `${text}\n\n${existing}` : text,
    });
    return;
  }
  const doc = new DOMParser().parseFromString(details.body || "", "text/html");
  const container = doc.createElement("div");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) container.appendChild(doc.createElement("br"));
    container.appendChild(doc.createTextNode(lines[i]));
  }
  container.appendChild(doc.createElement("br"));
  container.appendChild(doc.createElement("br"));
  doc.body.insertBefore(container, doc.body.firstChild);
  await browser.compose.setComposeDetails(tabId, { body: doc.body.innerHTML });
}

function setReplyBusy(busy) {
  state.sending = busy;
  els.replyText.disabled = busy;
  els.replySend.disabled = busy;
  els.replyFull.disabled = busy;
  els.replySend.textContent = busy ? "Sending…" : "Send";
}

async function quickSend() {
  if (state.sending) return;
  const group = state.groups.get(state.selectedKey);
  const text = els.replyText.value.trim();
  if (!group || !text) return;

  setReplyBusy(true);
  let composeTab = null;
  try {
    composeTab = await beginComposeFor(group);
    await injectReplyText(composeTab.id, text);
    await browser.compose.sendMessage(composeTab.id, { mode: "sendNow" });
    // The window usually closes itself after sending; make sure.
    try { await browser.tabs.remove(composeTab.id); } catch (e) {}
    els.replyText.value = "";
    els.replyText.style.height = "auto";
    drafts.delete(group.key);
    setReplyTarget(null);
    setStatus(`Reply to ${group.name} sent`);
  } catch (e) {
    // Leave the compose window open (it holds the text) and keep the draft.
    console.error("Quick reply failed:", e);
    setStatus(`Send failed: ${e.message}`);
  } finally {
    setReplyBusy(false);
  }
}

async function openFullCompose() {
  if (state.sending) return;
  const group = state.groups.get(state.selectedKey);
  if (!group) return;
  const text = els.replyText.value.trim();
  try {
    const composeTab = await beginComposeFor(group);
    if (text) {
      await injectReplyText(composeTab.id, text);
      els.replyText.value = "";
      els.replyText.style.height = "auto";
      drafts.delete(group.key);
    }
  } catch (e) {
    console.error("Open compose failed:", e);
    setStatus(`Could not open compose: ${e.message}`);
  }
}

/* ---------------- sort toggle ---------------- */

async function toggleUnreadFirst() {
  state.unreadFirst = !state.unreadFirst;
  updateUnreadFirstButton();
  renderSenderList();
  await browser.storage.local.set({ unreadFirst: state.unreadFirst });
}

function updateUnreadFirstButton() {
  els.unreadFirstToggle.classList.toggle("active", state.unreadFirst);
  els.unreadFirstToggle.title = state.unreadFirst
    ? "Unread senders are grouped at the top. Click to sort purely by most recent."
    : "Senders are sorted purely by most recent. Click to group unread senders at the top.";
}

async function toggleSort() {
  state.sortAsc = !state.sortAsc;
  updateSortButton();
  renderConversation();
  await browser.storage.local.set({ convSortAsc: state.sortAsc });
}

function updateSortButton() {
  els.sortToggle.textContent = state.sortAsc ? "Oldest first ↓" : "Newest first ↓";
  els.sortToggle.title = state.sortAsc
    ? "Showing oldest at top, newest at bottom (chat-style). Click to reverse."
    : "Showing newest at top. Click to reverse.";
}

/* ---------------- helpers ---------------- */

function initialsFor(name) {
  const words = name.replace(/[^\p{L}\p{N} @.]/gu, "").trim().split(/\s+/);
  if (words.length >= 2 && /\p{L}|\p{N}/u.test(words[0]) && /\p{L}|\p{N}/u.test(words[1])) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  const first = name.trim()[0];
  return first ? first.toUpperCase() : "?";
}

function formatListTime(timestamp) {
  if (timestamp < 0) return "";
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setStatus(text) {
  els.status.textContent = text;
}
