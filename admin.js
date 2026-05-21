// admin.js — chat history storage + manual reply admin panel for wa-bridge
// Loaded by server.js; provides logIncoming/logOutgoing/isPaused + /admin routes.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CHATS_DIR = "/docker/wa-webhook-sbsr/chats";
const READ_STATE_PATH = "/docker/wa-webhook-sbsr/chats/.read-state.json";
const MAX_MSGS = 500;

try { fs.mkdirSync(CHATS_DIR, { recursive: true }); } catch (_) {}

// ---------- storage ----------
const writeLocks = new Map();

function safePhone(raw) {
  const p = String(raw || "").replace(/[^0-9]/g, "");
  if (!p || p.length < 6 || p.length > 20) throw new Error("invalid phone: " + raw);
  return p;
}

function chatPath(phone) {
  const p = safePhone(phone);
  const full = path.join(CHATS_DIR, p + ".json");
  if (path.dirname(full) !== CHATS_DIR) throw new Error("path escape");
  return full;
}

function readChat(phone) {
  try {
    return JSON.parse(fs.readFileSync(chatPath(phone), "utf8"));
  } catch (_) {
    return { phone: safePhone(phone), name: "", paused: false, messages: [], createdAt: Date.now(), updatedAt: Date.now() };
  }
}

function writeChatAtomic(phone, data) {
  const p = chatPath(phone);
  const tmp = p + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, p);
}

function withLock(phone, fn) {
  const key = safePhone(phone);
  const prev = writeLocks.get(key) || Promise.resolve();
  const next = prev.then(fn).catch((e) => console.error("[admin] write error:", e.message));
  writeLocks.set(key, next.finally(() => { if (writeLocks.get(key) === next) writeLocks.delete(key); }));
  return next;
}

function appendMessage(phone, dir, text, name) {
  return withLock(phone, () => {
    const chat = readChat(phone);
    if (name && !chat.name) chat.name = String(name).slice(0, 120);
    chat.messages.push({ ts: Date.now(), dir, text: String(text == null ? "" : text).slice(0, 10000) });
    if (chat.messages.length > MAX_MSGS) chat.messages = chat.messages.slice(-MAX_MSGS);
    chat.updatedAt = Date.now();
    writeChatAtomic(phone, chat);
  });
}

const logIncoming = (phone, text, name) => appendMessage(phone, "in", text, name);
const logOutgoing = (phone, text) => appendMessage(phone, "out", text);

function isPaused(phone) {
  try { return !!readChat(phone).paused; } catch (_) { return false; }
}

function setPaused(phone, paused) {
  return withLock(phone, () => {
    const chat = readChat(phone);
    chat.paused = !!paused;
    chat.updatedAt = Date.now();
    writeChatAtomic(phone, chat);
  });
}

// ---------- read state (shared across all admins) ----------
const readStateLock = { p: Promise.resolve() };

function readReadState() {
  try { return JSON.parse(fs.readFileSync(READ_STATE_PATH, "utf8")); }
  catch (_) { return {}; }
}

function writeReadStateAtomic(state) {
  const tmp = READ_STATE_PATH + ".tmp." + process.pid + "." + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, READ_STATE_PATH);
}

function markChatRead(phone) {
  const key = safePhone(phone);
  // serialize writes globally to avoid file races
  readStateLock.p = readStateLock.p.then(() => {
    const s = readReadState();
    s[key] = Date.now();
    writeReadStateAtomic(s);
  }).catch((e) => console.error("[admin] read-state write error:", e.message));
  return readStateLock.p;
}

function listChats() {
  try {
    const files = fs.readdirSync(CHATS_DIR).filter((f) => f.endsWith(".json") && !f.includes(".tmp") && !f.startsWith("."));
    const readState = readReadState();
    const out = [];
    for (const f of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), "utf8"));
        const last = raw.messages[raw.messages.length - 1];
        const lastIn = [...raw.messages].reverse().find((m) => m.dir === "in");
        const lastReadAt = readState[raw.phone] || 0;
        // count incoming messages newer than lastReadAt
        let unreadCount = 0;
        for (const m of raw.messages) if (m.dir === "in" && m.ts > lastReadAt) unreadCount++;
        out.push({
          phone: raw.phone,
          name: raw.name || "",
          paused: !!raw.paused,
          lastTs: raw.updatedAt || 0,
          lastInTs: lastIn ? lastIn.ts : 0,
          lastDir: last ? last.dir : "",
          lastText: (last ? last.text : "").slice(0, 120),
          count: raw.messages.length,
          unreadCount,
          lastReadAt,
        });
      } catch (_) {}
    }
    // Sort: unread first (by latest unread incoming), then read by latest activity DESC
    out.sort((a, b) => {
      if ((a.unreadCount > 0) !== (b.unreadCount > 0)) return a.unreadCount > 0 ? -1 : 1;
      return b.lastTs - a.lastTs;
    });
    return out;
  } catch (_) { return []; }
}

function getChat(phone) { return readChat(phone); }

// ---------- CSV export (per-customer chat → CSV for bot-improvement review) ----------
// Three columns: timestamp (ISO8601), direction (in=customer, out=bot/admin), text.
// BOM prefix so Excel auto-detects UTF-8 (Indonesian chars + emoji render correctly).
function csvEscape(s) {
  const v = String(s == null ? "" : s);
  // RFC 4180: wrap in double quotes; escape embedded quotes by doubling them.
  // Newlines inside quoted fields are valid CSV — Excel/Sheets handle them.
  if (/[",\r\n]/.test(v)) return '"' + v.replace(/"/g, '""') + '"';
  return v;
}
function chatToCsv(chat) {
  const rows = ["timestamp,direction,text"];
  const msgs = Array.isArray(chat.messages) ? chat.messages : [];
  for (const m of msgs) {
    const ts = new Date(m.ts || 0).toISOString();
    const dir = m.dir === "in" ? "in" : "out";
    rows.push(csvEscape(ts) + "," + csvEscape(dir) + "," + csvEscape(m.text));
  }
  return "﻿" + rows.join("\r\n") + "\r\n";
}
function csvFilename(chat) {
  const name = (chat.name || "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 40).replace(/^_+|_+$/g, "");
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return "sbsr-chat-" + chat.phone + (name ? "-" + name : "") + "-" + date + ".csv";
}

function stats() {
  const list = listChats();
  let totalMsgs = 0, paused = 0, bytes = 0, totalUnread = 0;
  for (const c of list) { totalMsgs += c.count; if (c.paused) paused++; totalUnread += c.unreadCount; }
  try {
    for (const f of fs.readdirSync(CHATS_DIR)) bytes += fs.statSync(path.join(CHATS_DIR, f)).size;
  } catch (_) {}
  return { totalChats: list.length, totalMessages: totalMsgs, pausedChats: paused, diskKB: Math.round(bytes / 1024), totalUnread };
}

// ---------- admin UI ----------
const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Sentuh Rasa Admin Inbox</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='14' fill='%2325d366'/%3E%3Ctext x='50%25' y='58%25' text-anchor='middle' font-size='14' font-weight='700' fill='white'%3ESR%3C/text%3E%3C/svg%3E">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="ui-version" content="wa-polish-v2-20260426">
<style>
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;font:14px/1.4 -apple-system,Segoe UI,system-ui,Roboto,Helvetica,Arial,sans-serif;background:#eae6df;color:#222}
  #app{display:flex;height:100vh}
  #sidebar{width:380px;border-right:1px solid #d1d7db;background:#fff;display:flex;flex-direction:column;min-width:300px}
  #stats{padding:10px 14px;font-size:12px;color:#54656f;border-bottom:1px solid #e9edef;background:#f0f2f5;display:flex;justify-content:space-between;align-items:center;gap:8px}
  #stats .meta{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #stats .actions{display:flex;gap:6px;flex-shrink:0}
  #stats button{padding:5px 10px;font-size:11px;font-weight:500;border:1px solid #d1d7db;background:#fff;color:#54656f;border-radius:14px;cursor:pointer}
  #stats button:hover{background:#f5f6f6}
  #searchBar{padding:8px 12px;border-bottom:1px solid #e9edef;background:#fff;display:flex;gap:6px;align-items:center}
  #searchWrap{flex:1;position:relative;display:flex;align-items:center;background:#f0f2f5;border-radius:18px;padding:0 12px}
  #searchWrap::before{content:"🔍";font-size:12px;opacity:.5;margin-right:6px}
  #search{flex:1;padding:8px 0;font:inherit;border:0;background:transparent;outline:none;color:#3b4a54}
  #search::placeholder{color:#8696a0}
  #searchHint{font-size:10px;color:#aaa;flex-shrink:0;background:#f0f2f5;padding:2px 6px;border-radius:8px}
  #filterBar{display:flex;gap:6px;padding:6px 12px 8px;border-bottom:1px solid #e9edef;background:#fff;overflow-x:auto}
  #filterBar button{padding:5px 12px;font-size:12px;font-weight:500;border:0;background:#f0f2f5;color:#54656f;border-radius:14px;cursor:pointer;flex-shrink:0}
  #filterBar button.active{background:#d9fdd3;color:#1d8a3e}
  #filterBar button .ct{margin-left:5px;font-size:10px;opacity:.7}
  #filterBar button#reviewsBtn{padding:5px 12px;font-size:12px;font-weight:500;border:0;background:#fff3e0;color:#e65100;border-radius:14px;cursor:pointer;flex-shrink:0}
  #filterBar button#reviewsBtn.active{background:#ff9800;color:#fff}
  #filterBar button.reviews-tab{padding:5px 12px;font-size:12px;font-weight:500;border:0;background:#fff3e0;color:#e65100;border-radius:14px;cursor:pointer;flex-shrink:0}
  #filterBar button.reviews-tab.active{background:#ff9800;color:#fff}
  #list{flex:1;overflow-y:auto}
  .chat{padding:12px 14px;border-bottom:1px solid #f0f2f5;cursor:pointer;display:flex;gap:12px;align-items:center;transition:background .1s}
  .chat:hover{background:#f5f6f6}
  .chat.active{background:#f0f2f5}
  .avatar{width:42px;height:42px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;font-size:15px;letter-spacing:.5px;text-transform:uppercase;user-select:none}
  .chat-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px}
  .chat .name{display:flex;justify-content:space-between;align-items:center;gap:6px;font-weight:400;color:#111b21}
  .chat.unread .name{font-weight:600}
  .chat .name .left{flex:1;display:flex;align-items:center;gap:6px;overflow:hidden}
  .chat .name .nameTxt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .chat .preview{color:#667781;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:flex;justify-content:space-between;gap:6px;align-items:center}
  .chat.unread .preview{color:#3b4a54}
  .chat .preview .txt{flex:1;overflow:hidden;text-overflow:ellipsis;display:flex;align-items:center;gap:4px}
  .preview .dirIcon{font-size:11px;color:#667781;flex-shrink:0}
  .pause-badge{background:#ff9800;color:#fff;font-size:10px;padding:1px 6px;border-radius:8px;flex-shrink:0;font-weight:500}
  .unread-badge{background:#25d366;color:#fff;font-size:11px;padding:2px 8px;border-radius:11px;flex-shrink:0;font-weight:600;min-width:20px;text-align:center;line-height:1.2}
  .ts{font-size:12px;color:#667781;flex-shrink:0;font-weight:400}
  .chat.unread .ts{color:#25d366;font-weight:600}
  #emptyList{padding:30px 20px;text-align:center;color:#8696a0;font-size:13px}
  #main{flex:1;display:flex;flex-direction:column;background:#efeae2;background-image:linear-gradient(rgba(229,221,213,.15) 1px,transparent 1px),linear-gradient(90deg,rgba(229,221,213,.15) 1px,transparent 1px);background-size:24px 24px}
  #header{padding:10px 16px;border-bottom:1px solid #d1d7db;background:#f0f2f5;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-shrink:0}
  #header .left{display:flex;align-items:center;gap:12px;flex:1;min-width:0}
  #header .info{flex:1;min-width:0}
  #header .title{font-weight:500;color:#111b21;font-size:16px;line-height:1.2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #header .meta{font-size:12px;color:#667781;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #header .meta.warn{color:#b54708}
  #thread{flex:1;overflow-y:auto;padding:14px 8% 14px;display:flex;flex-direction:column;gap:2px}
  .day-sep{align-self:center;background:#fff;color:#54656f;font-size:11px;font-weight:500;padding:4px 12px;border-radius:8px;margin:14px 0 8px;box-shadow:0 1px 1px rgba(0,0,0,.05);text-transform:uppercase;letter-spacing:.5px}
  .msg{max-width:65%;padding:6px 10px 8px;border-radius:8px;white-space:pre-wrap;word-wrap:break-word;position:relative;box-shadow:0 1px .5px rgba(11,20,26,.13);font-size:14px;line-height:1.4;color:#111b21;margin:1px 0}
  .msg.in{background:#fff;align-self:flex-start;border-top-left-radius:0}
  .msg.in::before{content:"";position:absolute;left:-8px;top:0;width:8px;height:13px;background:#fff;clip-path:polygon(100% 0,100% 100%,0 0)}
  .msg.out{background:#d9fdd3;align-self:flex-end;border-top-right-radius:0}
  .msg.out::before{content:"";position:absolute;right:-8px;top:0;width:8px;height:13px;background:#d9fdd3;clip-path:polygon(0 0,0 100%,100% 0)}
  .msg.same-author{margin-top:1px}
  .msg.same-author::before{display:none}
  .msg.in.same-author{border-top-left-radius:8px}
  .msg.out.same-author{border-top-right-radius:8px}
  .msg .ts{display:inline-block;font-size:11px;color:#667781;margin-left:8px;float:right;margin-top:4px;font-weight:400}
  .msg.out .ts{color:#54656f}
  .msg.out .ts::after{content:" \\2713\\2713";color:#53bdeb;font-weight:600}
  #composer{padding:10px 16px;border-top:1px solid #d1d7db;background:#f0f2f5;display:flex;gap:8px;align-items:flex-end;flex-shrink:0}
  #composer textarea{flex:1;padding:9px 14px;font:inherit;border:0;border-radius:8px;resize:none;height:42px;max-height:160px;background:#fff;outline:none;color:#3b4a54}
  button.primary{padding:0;border:0;width:42px;height:42px;border-radius:50%;background:#25d366;color:#fff;font-weight:600;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
  button.primary:hover{background:#1da851}
  button.primary:disabled{opacity:.5;cursor:not-allowed}
  button.secondary{padding:7px 14px;border:1px solid #d1d7db;border-radius:14px;background:#fff;color:#54656f;font-weight:500;cursor:pointer;font-size:13px}
  button.secondary:hover{background:#f5f6f6}
  button.warn{background:#fff;color:#b54708;border:1px solid #fed7aa;padding:7px 14px;border-radius:14px;font-weight:500;cursor:pointer;font-size:13px}
  button.warn:hover{background:#fff7ed}
  #empty{flex:1;display:flex;align-items:center;justify-content:center;color:#54656f;flex-direction:column;gap:10px;background:#f0f2f5;background-image:none}
  #empty .em-emoji{font-size:64px;opacity:.6}
  #empty .em-text{font-size:14px}
  #toast{position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#323739;color:#fff;padding:12px 20px;border-radius:8px;display:none;max-width:80%;z-index:200;box-shadow:0 4px 12px rgba(0,0,0,.2);font-size:13px}

  /* ── Back button (hidden on desktop, shown on mobile in chat header) ── */
  .back-btn{display:none;background:transparent;border:0;color:#54656f;font-size:22px;cursor:pointer;padding:6px 8px;margin-right:4px;flex-shrink:0;line-height:1}
  .back-btn:hover{color:#111b21}

  /* ── Mobile responsive (phones / narrow tablets) ── */
  @media (max-width: 768px) {
    #app{display:block;height:100vh;height:100dvh;position:relative;overflow:hidden}
    #sidebar{width:100%;min-width:0;height:100%;border-right:0}
    #main{display:none;width:100%;height:100%;position:absolute;inset:0;background:#efeae2}
    body.in-chat #sidebar{display:none}
    body.in-chat #main{display:flex}
    .back-btn{display:flex !important;align-items:center;justify-content:center}
    /* Touch-friendly hit targets (Apple HIG min 44pt, Material 48dp) */
    #composer{padding:8px 10px;gap:6px}
    #composer textarea{font-size:16px !important;min-height:44px;padding:10px 14px}  /* 16px font prevents iOS auto-zoom on focus */
    button.primary{width:44px;height:44px;font-size:20px}
    /* Wider message bubbles on small screens */
    .msg{max-width:85%}
    /* Smaller padding in thread on mobile */
    #thread{padding:10px 4% 10px}
    /* Stats bar wraps on tiny screens */
    #stats{flex-wrap:wrap;gap:6px}
    #stats .meta{font-size:11px}
    /* Modal full-width on mobile */
    #modal{width:92vw;padding:18px}
  }
  #reviews{flex:1;overflow-y:auto;padding:12px;display:none}
  #reviews.active{display:block}
  .review-card{background:#fff;border-radius:10px;padding:14px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.08);border-left:3px solid #ff9800}
  .review-card .r-name{font-weight:600;font-size:15px;color:#111b21}
  .review-card .r-phone{font-size:12px;color:#667781;margin:2px 0 8px}
  .review-card .r-detail{font-size:13px;color:#3b4a54;margin:4px 0;display:flex;justify-content:space-between}
  .review-card .r-detail .r-label{color:#667781}
  .review-card .r-actions{display:flex;gap:8px;margin-top:10px}
  .review-card .r-actions button{flex:1;padding:8px 12px;border-radius:8px;font-weight:600;font-size:13px;cursor:pointer;border:0}
  .review-card .r-approve{background:#25d366;color:#fff}
  .review-card .r-approve:hover{background:#1da851}
  .review-card .r-approve:disabled{opacity:.5;cursor:not-allowed}
  .review-card .r-reject{background:#fff;color:#e74c3c;border:1px solid #e74c3c}
  .review-card .r-reject:hover{background:#fff5f5}
  .review-card .r-reject:disabled{opacity:.5;cursor:not-allowed}
  .review-card .r-img{margin-top:8px}
  .review-card .r-img a{color:#25d366;font-size:12px;text-decoration:none}
  .review-card .r-img a:hover{text-decoration:underline}
  .review-card .r-status{font-size:11px;color:#667781;margin-top:6px;font-style:italic}
  .review-empty{padding:30px 20px;text-align:center;color:#8696a0;font-size:13px}
  #reviews-loading{padding:20px;text-align:center;color:#8696a0;font-size:13px}
  #reviews{flex:1;overflow-y:auto;padding:12px;display:none}
  #reviews.active{display:block}
  .review-card{background:#fff;border-radius:10px;padding:14px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.08);border-left:3px solid #ff9800}
  .review-card .r-name{font-weight:600;font-size:15px;color:#111b21}
  .review-card .r-phone{font-size:12px;color:#667781;margin:2px 0 8px}
  .review-card .r-detail{font-size:13px;color:#3b4a54;margin:4px 0;display:flex;justify-content:space-between}
  .review-card .r-detail .r-label{color:#667781}
  .review-card .r-actions{display:flex;gap:8px;margin-top:10px}
  .review-card .r-actions button{flex:1;padding:8px 12px;border-radius:8px;font-weight:600;font-size:13px;cursor:pointer;border:0}
  .review-card .r-approve{background:#25d366;color:#fff}
  .review-card .r-approve:hover{background:#1da851}
  .review-card .r-approve:disabled{opacity:.5;cursor:not-allowed}
  .review-card .r-reject{background:#fff;color:#e74c3c;border:1px solid #e74c3c}
  .review-card .r-reject:hover{background:#fff5f5}
  .review-card .r-reject:disabled{opacity:.5;cursor:not-allowed}
  .review-card .r-img{margin-top:8px}
  .review-card .r-img a{color:#25d366;font-size:12px;text-decoration:none}
  .review-card .r-img a:hover{text-decoration:underline}
  .review-card .r-status{font-size:11px;color:#667781;margin-top:6px;font-style:italic}
  .review-empty{padding:30px 20px;text-align:center;color:#8696a0;font-size:13px}
  #reviews-loading{padding:20px;text-align:center;color:#8696a0;font-size:13px}
  #modalBg{position:fixed;inset:0;background:rgba(0,0,0,0.45);display:none;align-items:center;justify-content:center;z-index:100}
  #modalBg.open{display:flex}
  #modal{background:#fff;border-radius:8px;padding:24px;width:440px;max-width:90vw;box-shadow:0 10px 40px rgba(0,0,0,0.2)}
  #modal h3{margin:0 0 16px 0;font-size:18px;color:#111b21;font-weight:500}
  #modal label{display:block;font-size:12px;color:#54656f;margin-bottom:6px;margin-top:14px;font-weight:500}
  #modal input,#modal textarea{width:100%;padding:9px 12px;font:inherit;border:1px solid #d1d7db;border-radius:6px;outline:none;color:#3b4a54}
  #modal input:focus,#modal textarea:focus{border-color:#25d366}
  #modal textarea{resize:vertical;min-height:90px}
  #normalizedHint{font-size:11px;color:#54656f;margin-top:4px;min-height:14px}
  #normalizedHint.ok{color:#1d8a3e}
  #modalWindow{margin-top:12px;padding:10px 12px;border-radius:6px;font-size:12px;display:none;line-height:1.45}
  #modalWindow.warn{display:block;background:#fff7ed;color:#b54708;border:1px solid #fed7aa}
  #modalWindow.ok{display:block;background:#d9fdd3;color:#1d8a3e;border:1px solid #b6e3a8}
  #modalActions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}
  #modalActions button.cancel{background:#fff;color:#54656f;border:1px solid #d1d7db;padding:8px 18px;border-radius:6px;cursor:pointer;font-weight:500}
  #modalActions button.send{background:#25d366;color:#fff;border:0;padding:8px 22px;border-radius:6px;cursor:pointer;font-weight:600}
  #modalActions button.send:disabled{opacity:.5;cursor:not-allowed}
</style></head>
<body><div id="app">
  <div id="sidebar">
    <div id="stats">
      <span class="meta">loading…</span>
      <span class="actions">
        <button id="newChatBtn" title="Compose new chat (Cmd/Ctrl+N)">+ New</button>
        <button id="notifBtn" title="Browser alerts">🔔 Alerts</button>
      </span>
    </div>
    <div id="searchBar">
      <span id="searchWrap">
        <input id="search" placeholder="Search name, phone, or message…" autocomplete="off">
      </span>
      <span id="searchHint">⌘K</span>
    </div>
    <div id="filterBar">
      <button data-filter="all" class="active">All <span class="ct" id="ctAll"></span></button>
      <button data-filter="unread">Unread <span class="ct" id="ctUnread"></span></button>
      <button data-filter="paused">Paused <span class="ct" id="ctPaused"></span></button>
      <button id="reviewsBtn" class="reviews-tab">📋 Reviews <span class="ct" id="ctReviews"></span></button>
    </div>
    <div id="list"></div>
    <div id="reviews"></div>
  </div>
  <div id="main"><div id="empty"><div class="em-emoji">💬</div><div class="em-text">Select a conversation to start chatting</div></div></div>
</div>
<div id="toast"></div>
<div id="modalBg">
  <div id="modal">
    <h3>Compose new chat</h3>
    <label for="modalPhone">Phone number</label>
    <input id="modalPhone" placeholder="08xx, +62xx, or 62xx…" list="phoneAutocomplete" autocomplete="off">
    <div id="normalizedHint"></div>
    <datalist id="phoneAutocomplete"></datalist>
    <label for="modalText">Message</label>
    <textarea id="modalText" placeholder="Type message…"></textarea>
    <div id="modalWindow"></div>
    <div id="modalActions">
      <button class="cancel" id="modalCancel">Cancel</button>
      <button class="send" id="modalSend">Send</button>
    </div>
  </div>
</div>
<script>
const H = { "x-admin-request": "1", "Authorization": "Basic __AUTH_HEADER__" };
let activePhone = null;
let chats = [];
let allChats = []; // unfiltered cache
let lastSeenInTs = Number(localStorage.getItem("lastSeenInTs") || 0);
let audioCtx = null;
let searchQuery = "";
let activeFilter = localStorage.getItem("activeFilter") || "all";

document.addEventListener("click", () => {
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  if (!audioCtx) { try { audioCtx = new (window.AudioContext||window.webkitAudioContext)(); } catch(_){} }
}, { once: true });

function playBeep() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.value = 880; o.type = "sine";
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.35);
    o.start(); o.stop(audioCtx.currentTime + 0.4);
    setTimeout(() => { try { const o2=audioCtx.createOscillator(),g2=audioCtx.createGain();o2.connect(g2);g2.connect(audioCtx.destination);o2.frequency.value=1100;o2.type="sine";g2.gain.setValueAtTime(0.0001,audioCtx.currentTime);g2.gain.exponentialRampToValueAtTime(0.2,audioCtx.currentTime+0.02);g2.gain.exponentialRampToValueAtTime(0.0001,audioCtx.currentTime+0.3);o2.start();o2.stop(audioCtx.currentTime+0.35);} catch(_){} }, 180);
  } catch (_) {}
}

function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    try { const n = new Notification(title, { body, tag: "sbsr-admin", renotify: true }); setTimeout(()=>n.close(), 8000); } catch(_) {}
  }
}

function checkForNew(newChats) {
  let maxTs = lastSeenInTs;
  const fresh = [];
  for (const c of newChats) {
    if (c.lastInTs > lastSeenInTs) { fresh.push(c); if (c.lastInTs > maxTs) maxTs = c.lastInTs; }
  }
  if (fresh.length && lastSeenInTs > 0) {
    playBeep();
    const f = fresh[0];
    notify("New message from " + (f.name || f.phone), f.lastText);
  }
  if (maxTs > lastSeenInTs) { lastSeenInTs = maxTs; localStorage.setItem("lastSeenInTs", String(maxTs)); }
}

function fmtTs(ts){const d=new Date(ts);return d.toLocaleString()}
function fmtTime(ts){const d=new Date(ts);return d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
function fmtShort(ts){
  const d=new Date(ts), now=new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
  const yest = new Date(now); yest.setDate(yest.getDate()-1);
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  const diff = (now-d)/86400000;
  if (diff < 7) return d.toLocaleDateString([], {weekday:"short"});
  return d.toLocaleDateString([], {day:"2-digit",month:"2-digit",year:"2-digit"});
}
function dayLabel(ts){
  const d=new Date(ts), now=new Date();
  if (d.toDateString() === now.toDateString()) return "TODAY";
  const yest = new Date(now); yest.setDate(yest.getDate()-1);
  if (d.toDateString() === yest.toDateString()) return "YESTERDAY";
  const diff = (now-d)/86400000;
  if (diff < 7) return d.toLocaleDateString([], {weekday:"long"});
  return d.toLocaleDateString([], {day:"numeric",month:"long",year:"numeric"});
}
function toast(msg){const t=document.getElementById("toast");t.textContent=msg;t.style.display="block";setTimeout(()=>t.style.display="none",4000)}

const AVATAR_COLORS = ["#25d366","#34b7f1","#9c27b0","#ff5722","#3f51b5","#009688","#e91e63","#673ab7","#795548","#607d8b","#f44336","#00bcd4"];
function avatarColor(phone){
  let h = 0; const s = String(phone||"");
  for (let i=0;i<s.length;i++) h = (h*31 + s.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
function initials(name, phone){
  const src = (name||"").trim();
  if (src) {
    const parts = src.split(/\\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0]+parts[1][0]).toUpperCase();
    return parts[0].slice(0,2).toUpperCase();
  }
  const p = String(phone||"").replace(/\\D/g,"");
  return p.slice(-2);
}
function buildAvatar(name, phone){
  const a = document.createElement("div");
  a.className = "avatar";
  a.style.background = avatarColor(phone);
  a.textContent = initials(name, phone);
  return a;
}
function normalizePhone(raw){
  let d = String(raw||"").replace(/[^0-9+]/g,"");
  if (d.startsWith("+")) d = d.slice(1);
  d = d.replace(/[^0-9]/g,"");
  if (!d) return "";
  if (d.startsWith("0")) d = "62" + d.slice(1);
  else if (d.startsWith("8") && d.length >= 9 && d.length <= 12) d = "62" + d;
  return d;
}

async function api(path, opts) {
  const r = await fetch(path, Object.assign({ credentials: "same-origin", headers: H }, opts || {}));
  if (!r.ok) { const t=await r.text(); throw new Error(r.status+": "+t) }
  return r.json();
}

async function loadChats() {
  try {
    const [list, s] = await Promise.all([api("/admin/api/chats"), api("/admin/api/stats")]);
    checkForNew(list);
    allChats = list;
    chats = applyView(list);
    const titlePrefix = s.totalUnread > 0 ? "(" + s.totalUnread + ") " : "";
    document.title = titlePrefix + "Sentuh Rasa Admin Inbox";
    document.querySelector("#stats .meta").textContent =
      s.totalChats+" chats · "+s.totalMessages+" msgs · "+s.totalUnread+" unread · "+s.pausedChats+" paused";
    refreshAutocomplete();
    updateFilterCounts();
    renderList();
  } catch (e) { toast("load err: "+e.message) }
}

function filterChats(list, q) {
  if (!q) return list;
  const needle = q.toLowerCase().trim();
  return list.filter((c) =>
    (c.name||"").toLowerCase().includes(needle) ||
    c.phone.includes(needle.replace(/[^0-9]/g, "")) ||
    (c.lastText||"").toLowerCase().includes(needle)
  );
}
function filterByView(list, view){
  if (view === "unread") return list.filter(c => c.unreadCount > 0);
  if (view === "paused") return list.filter(c => c.paused);
  return list;
}
function applyView(list){ return filterChats(filterByView(list, activeFilter), searchQuery); }

function updateFilterCounts(){
  const ctAll = document.getElementById("ctAll"); if (ctAll) ctAll.textContent = allChats.length;
  const ctU = document.getElementById("ctUnread"); if (ctU) ctU.textContent = allChats.filter(c=>c.unreadCount>0).length;
  const ctP = document.getElementById("ctPaused"); if (ctP) ctP.textContent = allChats.filter(c=>c.paused).length;
  for (const b of document.querySelectorAll("#filterBar button")) {
    b.classList.toggle("active", b.dataset.filter === activeFilter);
  }
}

function refreshAutocomplete() {
  const dl = document.getElementById("phoneAutocomplete");
  dl.innerHTML = "";
  for (const c of allChats) {
    const o = document.createElement("option");
    o.value = "+" + c.phone;
    o.label = c.name || c.phone;
    dl.appendChild(o);
  }
}

function renderList() {
  const el = document.getElementById("list");
  el.innerHTML = "";
  if (chats.length === 0) {
    const empty = document.createElement("div");
    empty.id = "emptyList";
    empty.textContent = searchQuery ? 'No chats match "' + searchQuery + '"' :
      activeFilter === "unread" ? "No unread chats — all caught up ✨" :
      activeFilter === "paused" ? "No paused chats" : "No chats yet";
    el.appendChild(empty);
    return;
  }
  for (const c of chats) {
    const d = document.createElement("div");
    d.className = "chat" + (c.phone === activePhone ? " active" : "") + (c.unreadCount > 0 ? " unread" : "");
    d.appendChild(buildAvatar(c.name, c.phone));
    const body = document.createElement("div"); body.className = "chat-body";
    const nameRow = document.createElement("div"); nameRow.className = "name";
    const left = document.createElement("span"); left.className = "left";
    const nameTxt = document.createElement("span"); nameTxt.className = "nameTxt"; nameTxt.textContent = c.name || ("+" + c.phone);
    left.appendChild(nameTxt);
    if (c.paused) { const b=document.createElement("span"); b.className="pause-badge"; b.textContent="PAUSED"; left.appendChild(b) }
    nameRow.appendChild(left);
    const tsSpan = document.createElement("span"); tsSpan.className = "ts";
    tsSpan.textContent = c.lastTs ? fmtShort(c.lastTs) : "";
    nameRow.appendChild(tsSpan);
    body.appendChild(nameRow);
    const prev = document.createElement("div"); prev.className = "preview";
    const txt = document.createElement("span"); txt.className = "txt";
    if (c.lastDir === "out") {
      const dirIcon = document.createElement("span"); dirIcon.className = "dirIcon"; dirIcon.textContent = "✓✓ ";
      txt.appendChild(dirIcon);
    }
    const txtNode = document.createElement("span"); txtNode.textContent = c.lastText;
    txt.appendChild(txtNode);
    prev.appendChild(txt);
    if (c.unreadCount > 0) {
      const u = document.createElement("span"); u.className = "unread-badge"; u.textContent = c.unreadCount;
      prev.appendChild(u);
    }
    body.appendChild(prev);
    d.appendChild(body);
    d.onclick = () => openChat(c.phone);
    el.appendChild(d);
  }
}

async function openChat(phone) {
  activePhone = phone;
  // mark read on open (optimistic UI: update local cache + re-render before API completes)
  for (const c of allChats) if (c.phone === phone) { c.unreadCount = 0; }
  chats = applyView(allChats);
  updateFilterCounts();
  renderList();
  try {
    const [chat] = await Promise.all([
      api("/admin/api/chat/" + phone),
      api("/admin/api/mark-read", { method:"POST", headers:Object.assign({"content-type":"application/json"},H), body: JSON.stringify({ phone }) }).catch(()=>{}),
    ]);
    renderThread(chat);
  } catch (e) { toast("open err: "+e.message) }
}

function renderThread(chat) {
  const main = document.getElementById("main");
  main.innerHTML = "";
  // Mobile: mark body so CSS shows #main and hides #sidebar
  document.body.classList.add("in-chat");
  const header = document.createElement("div"); header.id = "header";
  const left = document.createElement("div"); left.className = "left";
  // Mobile back button (hidden on desktop via CSS)
  const backBtn = document.createElement("button"); backBtn.className = "back-btn"; backBtn.innerHTML = "&#10094;"; backBtn.title = "Back to chat list";
  backBtn.onclick = () => { document.body.classList.remove("in-chat"); activePhone = null; };
  left.appendChild(backBtn);
  left.appendChild(buildAvatar(chat.name, chat.phone));
  const info = document.createElement("div"); info.className = "info";
  const titleEl = document.createElement("div"); titleEl.className = "title"; titleEl.textContent = (chat.name || ("+" + chat.phone));
  const metaEl = document.createElement("div"); metaEl.className = "meta";
  const lastIn = [...chat.messages].reverse().find(m=>m.dir==="in");
  const hrs = lastIn ? Math.round((Date.now()-lastIn.ts)/3600000) : null;
  if (lastIn) {
    metaEl.textContent = "+" + chat.phone + " · last msg " + hrs + "h ago" + (hrs>=24?" — 24h window closed":"");
    if (hrs >= 24) metaEl.classList.add("warn");
  } else {
    metaEl.textContent = "+" + chat.phone + " · no incoming messages yet";
  }
  info.appendChild(titleEl); info.appendChild(metaEl);
  left.appendChild(info);
  header.appendChild(left);

  const btns = document.createElement("div");
  btns.style.display = "flex"; btns.style.gap = "6px";

  // CSV export: download this customer's full chat as a CSV (timestamp,direction,text).
  // Used for bot-improvement review (paste into LLM, spot regressions, etc.).
  const csvBtn = document.createElement("button");
  csvBtn.textContent = "📥 Export";
  csvBtn.className = "secondary";
  csvBtn.title = "Download chat as CSV";
  csvBtn.onclick = async () => {
    csvBtn.disabled = true;
    try {
      const r = await fetch("/admin/api/chat/" + chat.phone + "/csv", { credentials: "same-origin", headers: H });
      if (!r.ok) throw new Error(r.status + ": " + await r.text());
      const blob = await r.blob();
      // Pull filename from Content-Disposition; fall back to a sane default.
      let fname = "chat-" + chat.phone + ".csv";
      const cd = r.headers.get("content-disposition") || "";
      const m = cd.match(/filename="([^"]+)"/);
      if (m) fname = m[1];
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("CSV downloaded (" + (chat.messages||[]).length + " msgs)");
    } catch (e) { toast("CSV err: " + e.message); }
    finally { csvBtn.disabled = false; }
  };
  btns.appendChild(csvBtn);

  const pauseBtn = document.createElement("button");
  pauseBtn.textContent = chat.paused ? "▶ Resume bot" : "⏸ Pause bot";
  pauseBtn.className = chat.paused ? "secondary" : "warn";
  pauseBtn.onclick = async () => {
    try {
      await api("/admin/api/pause", { method:"POST", headers:Object.assign({"content-type":"application/json"},H),
        body: JSON.stringify({ phone: chat.phone, paused: !chat.paused }) });
      toast(chat.paused ? "Bot resumed" : "Bot paused — AI won't auto-reply");
      openChat(chat.phone); loadChats();
    } catch (e) { toast("pause err: "+e.message) }
  };
  btns.appendChild(pauseBtn);
  header.appendChild(btns);
  main.appendChild(header);

  const thread = document.createElement("div"); thread.id = "thread";
  let lastDay = null, lastDir = null;
  for (const m of chat.messages) {
    const dayK = new Date(m.ts).toDateString();
    if (dayK !== lastDay) {
      const sep = document.createElement("div"); sep.className = "day-sep"; sep.textContent = dayLabel(m.ts);
      thread.appendChild(sep);
      lastDay = dayK; lastDir = null;
    }
    const d = document.createElement("div");
    const sameAuthor = m.dir === lastDir;
    d.className = "msg " + m.dir + (sameAuthor ? " same-author" : "");
    d.textContent = m.text; // textContent prevents XSS
    const ts = document.createElement("span"); ts.className = "ts"; ts.textContent = fmtTime(m.ts);
    d.appendChild(ts);
    thread.appendChild(d);
    lastDir = m.dir;
  }
  main.appendChild(thread);

  const comp = document.createElement("div"); comp.id = "composer";
  const ta = document.createElement("textarea"); ta.placeholder = "Type a reply… (Shift+Enter for newline, Enter to send)"; ta.rows = 1;
  ta.oninput = () => { ta.style.height = "42px"; ta.style.height = Math.min(ta.scrollHeight, 160) + "px"; };
  const send = document.createElement("button"); send.className = "primary"; send.title = "Send"; send.textContent = "➤";
  const doSend = async () => {
    const text = ta.value.trim(); if (!text) return;
    send.disabled = true;
    try {
      await api("/admin/api/send", { method:"POST",
        headers: Object.assign({"content-type":"application/json"}, H),
        body: JSON.stringify({ phone: chat.phone, text }) });
      ta.value = ""; ta.style.height = "42px"; await openChat(chat.phone); loadChats();
    } catch (e) { toast("send err: "+e.message) }
    finally { send.disabled = false }
  };
  send.onclick = doSend;
  // Mobile-safe Enter handling. On phones the keyboard's Enter is conventionally
  // newline (and Gboard/Samsung keyboards fire bogus Enter events during autocomplete
  // → bug: textarea would clear on the 3rd space). On desktop, keep Enter = send,
  // Shift+Enter = newline. Send button (➤) always works.
  const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  ta.onkeydown = (e) => {
    if (e.isComposing || e.keyCode === 229) return;     // IME composition / autocorrect
    if (isTouchDevice) return;                           // mobile: Enter = newline
    if ((e.key === "Enter" || e.code === "Enter") && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      doSend();
    }
  };
  comp.appendChild(ta); comp.appendChild(send);
  main.appendChild(comp);
  thread.scrollTop = thread.scrollHeight;
}

// ---------- search ----------
const searchEl = document.getElementById("search");
let searchDebounce = null;
searchEl.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchQuery = searchEl.value;
    chats = applyView(allChats);
    renderList();
  }, 150);
});

// ---------- filter tabs ----------
document.getElementById("filterBar").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  activeFilter = b.dataset.filter;
  localStorage.setItem("activeFilter", activeFilter);
  chats = applyView(allChats);
  updateFilterCounts();
  renderList();
});

// ---------- compose modal ----------
const modalBg = document.getElementById("modalBg");
const modalPhone = document.getElementById("modalPhone");
const modalText = document.getElementById("modalText");
const modalWindow = document.getElementById("modalWindow");
const modalSend = document.getElementById("modalSend");
const modalCancel = document.getElementById("modalCancel");
const newChatBtn = document.getElementById("newChatBtn");
const normalizedHint = document.getElementById("normalizedHint");

function updateModalWindow() {
  const raw = modalPhone.value.trim();
  const digits = normalizePhone(raw);
  modalWindow.className = "";
  modalWindow.textContent = "";
  normalizedHint.className = "";
  normalizedHint.textContent = "";
  const rawDigitsOnly = raw.replace(/[^0-9]/g,"");
  if (raw && digits && digits !== rawDigitsOnly) {
    normalizedHint.className = "ok";
    normalizedHint.textContent = "→ will send to +" + digits;
  } else if (digits) {
    normalizedHint.textContent = "→ +" + digits;
  }
  if (digits.length < 8) return;
  const existing = allChats.find((c) => c.phone === digits);
  if (!existing || !existing.lastInTs) {
    modalWindow.className = "warn";
    modalWindow.textContent = "⚠️ This number hasn't messaged the bot recently. Meta may silently drop the message (24h window closed). For cold outreach you need an approved template.";
    return;
  }
  const hrs = (Date.now() - existing.lastInTs) / 3600000;
  if (hrs >= 24) {
    modalWindow.className = "warn";
    modalWindow.textContent = "⚠️ Last incoming was " + Math.round(hrs) + "h ago — outside 24h window. Meta may block delivery.";
  } else {
    modalWindow.className = "ok";
    modalWindow.textContent = "✓ In 24h window (last incoming " + Math.round(hrs) + "h ago) — delivery will work.";
  }
}

function openModal() {
  modalBg.classList.add("open");
  setTimeout(() => modalPhone.focus(), 50);
}
function closeModal() {
  modalBg.classList.remove("open");
  modalPhone.value = ""; modalText.value = "";
  modalWindow.className = ""; modalWindow.textContent = "";
  normalizedHint.className = ""; normalizedHint.textContent = "";
}
newChatBtn.onclick = openModal;
modalCancel.onclick = closeModal;
modalBg.addEventListener("click", (e) => { if (e.target === modalBg) closeModal(); });
modalPhone.addEventListener("input", updateModalWindow);

modalSend.onclick = async () => {
  const digits = normalizePhone(modalPhone.value);
  const text = modalText.value.trim();
  if (digits.length < 8 || digits.length > 20) { toast("Invalid phone number"); return; }
  if (!text) { toast("Message is empty"); return; }
  modalSend.disabled = true;
  try {
    await api("/admin/api/send", { method:"POST",
      headers: Object.assign({"content-type":"application/json"}, H),
      body: JSON.stringify({ phone: digits, text }) });
    toast("Sent to +" + digits);
    closeModal();
    await loadChats();
    openChat(digits);
  } catch (e) {
    toast("send err: " + e.message);
  } finally { modalSend.disabled = false; }
};

// ---------- keyboard shortcuts ----------
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    searchEl.focus();
    searchEl.select();
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
    e.preventDefault();
    openModal();
  } else if (e.key === "Escape") {
    if (modalBg.classList.contains("open")) closeModal();
    else if (document.activeElement === searchEl && searchEl.value) {
      searchEl.value = ""; searchQuery = ""; chats = applyView(allChats);
      renderList();
    }
  }
});

// ---------- notifications button ----------
function updateNotifBtn() {
  const b = document.getElementById("notifBtn"); if (!b) return;
  if (!("Notification" in window)) { b.style.display="none"; return; }
  if (Notification.permission === "granted") { b.textContent = "🔔 On"; b.style.background="#d9fdd3"; b.style.color="#1d8a3e"; b.disabled = true; }
  else if (Notification.permission === "denied") { b.textContent = "🔕 Blocked"; b.disabled = true; }
  else { b.textContent = "🔔 Alerts"; b.onclick = async () => { await Notification.requestPermission(); if (!audioCtx) { try { audioCtx = new (window.AudioContext||window.webkitAudioContext)(); } catch(_){} } updateNotifBtn(); }; }
}
updateNotifBtn();

// ---------- payment reviews ----------
let reviewsActive = false;
let reviewsData = [];

function showReviews() {
  reviewsActive = true;
  document.getElementById("list").style.display = "none";
  document.getElementById("reviews").style.display = "block";
  document.getElementById("reviews").className = "active";
  document.getElementById("searchBar").style.display = "none";
  document.querySelectorAll("#filterBar button").forEach(b => b.classList.remove("active"));
  document.getElementById("reviewsBtn").classList.add("active");
  document.body.classList.remove("in-chat");
  activePhone = null;
  fetchReviews();
}

function showChatList() {
  reviewsActive = false;
  document.getElementById("list").style.display = "";
  document.getElementById("reviews").style.display = "none";
  document.getElementById("reviews").className = "";
  document.getElementById("searchBar").style.display = "";
  document.getElementById("reviewsBtn").classList.remove("active");
  const af = document.querySelector("#filterBar button[data-filter='" + activeFilter + "']");
  if (af) af.classList.add("active");
}

async function fetchReviews() {
  const el = document.getElementById("reviews");
  el.innerHTML = "<div id='reviews-loading'>Loading payment reviews...</div>";
  try {
    const data = await api("/admin/api/pending-reviews");
    reviewsData = data;
    renderReviews(data);
  } catch (e) {
    el.innerHTML = "<div class='review-empty'>Error loading: " + e.message + "</div>";
  }
}

function renderReviews(data) {
  const el = document.getElementById("reviews");
  if (!data || data.length === 0) {
    el.innerHTML = "<div class='review-empty'>\u2705 No pending payment reviews</div>";
    return;
  }
  el.innerHTML = "<div style='padding:8px 4px;font-size:13px;font-weight:500;color:#54656f'>Pending Payment Reviews</div>";
  for (const r of data) {
    const card = document.createElement("div");
    card.className = "review-card";
    const itemsText = (r.items || []).map(i => i.name || i.sku).join(", ").slice(0, 80);
    const totalFmt = "Rp " + Number(r.total).toLocaleString("id-ID");
    const ocrFmt = r.ocr_amount ? "Rp " + Number(r.ocr_amount).toLocaleString("id-ID") : "-";
    const expFmt = "Rp " + Number(r.expected_amount).toLocaleString("id-ID");
    const matchBadge = r.match_status === "match" ? "\u2705" : r.match_status === "ocr_failed" ? "\u26a0\ufe0f OCR fail" : "\u274c Mismatch";
    const dateStr = r.created_at ? new Date(r.created_at).toLocaleString() : "-";
        // Build card content via innerHTML (safe parts)
    card.innerHTML =
      "<div class='r-name'>" + (r.customer_name || "?") + "</div>" +
      "<div class='r-phone'>+" + r.phone + " \u00b7 " + matchBadge + "</div>" +
      "<div class='r-detail'><span class='r-label'>Items</span><span>" + itemsText.slice(0, 60) + "</span></div>" +
      "<div class='r-detail'><span class='r-label'>Total</span><span>" + totalFmt + "</span></div>" +
      "<div class='r-detail'><span class='r-label'>OCR</span><span>" + ocrFmt + " / Expected: " + expFmt + "</span></div>" +
      "<div class='r-detail'><span class='r-label'>Kurir</span><span>" + (r.courier || "?") + "</span></div>" +
      (r.order_id ? "<div class='r-detail'><span class='r-label'>Order</span><span>" + r.order_id + "</span></div>" : "") +
      (r.bukti_url ? "<div class='r-img'>\ud83d\udcce <a href='" + r.bukti_url + "' target='_blank'>View bukti transfer</a></div>" : "") +
      "<div class='r-actions' id='r-acts-" + r.phone + "'></div>" +
      "<div class='r-status' id='status-" + r.phone + "'></div>" +
      "<div class='r-detail' style='font-size:11px;color:#aaa;margin-top:4px'>" + dateStr + "</div>";
    el.appendChild(card);
    // Attach approve/reject buttons via DOM to avoid onclick quoting bugs
    var actsEl = document.getElementById('r-acts-' + r.phone);
    if (actsEl) {
      var appBtn = document.createElement('button');
      appBtn.className = 'r-approve';
      appBtn.textContent = '\u2705 Approve';
      appBtn.onclick = function() { handleReview(r.phone, 'approve', this); };
      actsEl.appendChild(appBtn);
      var rejBtn = document.createElement('button');
      rejBtn.className = 'r-reject';
      rejBtn.textContent = '\u274c Reject';
      rejBtn.onclick = function() { handleReview(r.phone, 'reject', this); };
      actsEl.appendChild(rejBtn);
    }
  }
  const badge = document.getElementById("ctReviews");
  if (badge) badge.textContent = data.length;
}

async function handleReview(phone, action, btn) {
  btn.disabled = true;
  btn.textContent = action === "approve" ? "Approving..." : "Rejecting...";
  const statusEl = document.getElementById("status-" + phone);
  statusEl.textContent = "Processing...";
  const reason = action === "reject" ? (prompt("Reason for rejection:") || "rejected") : undefined;
  try {
    const tokenRes = await fetch("/admin/api/token", { credentials: "same-origin", headers: H });
    const tokenData = await tokenRes.json();
    const token = tokenData.token;
    if (!token) {
      statusEl.textContent = "Auth error - no token";
      btn.disabled = false;
      btn.textContent = action === "approve" ? "\u2705 Approve" : "\u274c Reject";
      return;
    }
    const res = await fetch("/admin/payment-review", {
      credentials: "same-origin",
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, H),
      body: JSON.stringify({ phone, action, reason, token })
    });
    const result = await res.json();
    if (result.ok) {
      statusEl.textContent = "\u2705 " + (action === "approve" ? "Approved!" : "Rejected!");
      btn.textContent = "Done";
      btn.style.opacity = "0.5";
      setTimeout(fetchReviews, 2000);
    } else {
      statusEl.textContent = "\u274c " + (result.error || result.admin_message || "Failed").slice(0, 80);
      btn.disabled = false;
      btn.textContent = action === "approve" ? "\u2705 Approve" : "\u274c Reject";
    }
  } catch (e) {
    statusEl.textContent = "Error: " + e.message;
    btn.disabled = false;
    btn.textContent = action === "approve" ? "\u2705 Approve" : "\u274c Reject";
  }
}

// ---------- startup ----------
loadChats();
setInterval(() => {
  loadChats();
  if (!activePhone) return;
  // Don't rebuild the chat panel if the user is composing a message —
  // openChat() does main.innerHTML = "" which would wipe the textarea draft.
  // Preserves draft when textarea has content OR is currently focused.
  const _ta = document.querySelector("#composer textarea");
  if (_ta && (_ta.value.trim() || document.activeElement === _ta)) return;
  openChat(activePhone);
}, 5000);
</script></body></html>`;

// ---------- auth (Basic) + CSRF + rate limit ----------
function mount(app, sendText, ADMIN_PASSWORD) {
  if (!ADMIN_PASSWORD) {
    console.error("[admin] ADMIN_PASSWORD not set; admin panel DISABLED");
    return;
  }
  const failures = new Map(); // ip -> {count, until}
  const LOCKOUT_MAX = 5, LOCKOUT_MS = 15 * 60 * 1000;

  function basicAuth(req, res, next) {
    const ip = req.ip || req.connection?.remoteAddress || "unknown";
    const f = failures.get(ip);
    if (f && f.until > Date.now()) return res.status(429).set("Retry-After", "900").send("Too many failed attempts. Try again later.");
    const h = req.headers.authorization || "";
    if (!h.startsWith("Basic ")) { res.set("WWW-Authenticate", 'Basic realm="Sentuh Rasa Admin"'); return res.status(401).send("Auth required"); }
    const decoded = Buffer.from(h.slice(6), "base64").toString();
    const pass = decoded.split(":").slice(1).join(":");
    const ok = pass.length === ADMIN_PASSWORD.length &&
      crypto.timingSafeEqual(Buffer.from(pass), Buffer.from(ADMIN_PASSWORD));
    if (!ok) {
      const cur = failures.get(ip) || { count: 0, until: 0 };
      cur.count++;
      if (cur.count >= LOCKOUT_MAX) { cur.until = Date.now() + LOCKOUT_MS; cur.count = 0; }
      failures.set(ip, cur);
      res.set("WWW-Authenticate", 'Basic realm="Sentuh Rasa Admin"');
      return res.status(401).send("Invalid credentials");
    }
    failures.delete(ip);
    next();
  }

  function csrf(req, res, next) {
    if (req.method !== "GET" && req.headers["x-admin-request"] !== "1")
      return res.status(403).json({ error: "missing x-admin-request header" });
    next();
  }

  app.get("/admin", basicAuth, (req, res) => {
    res.set("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:");
      const _authHeader = Buffer.from("admin:" + ADMIN_PASSWORD).toString("base64");
  const _htmlWithAuth = HTML.replace("__AUTH_HEADER__", _authHeader);
  res.type("html").send(_htmlWithAuth);
  });

  app.use("/admin/api", basicAuth, csrf);

  app.get("/admin/api/chats", (req, res) => { try { res.json(listChats()); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.get("/admin/api/stats", (req, res) => { try { res.json(stats()); } catch (e) { res.status(500).json({ error: e.message }); } });

  app.get("/admin/api/pending-reviews", async (req, res) => {
    try {
      const cp = require("child_process");
      cp.execFile("docker", ["exec", "sbsr-openclaw-1", "node", "-e", "const fs=require('fs');const o=JSON.parse(fs.readFileSync('/data/.openclaw/workspace/orders.json','utf8'));const pending=[];for(const[k,v]of Object.entries(o)){if(v.state==='awaiting_manual_payment_review'||v.payment_review_state==='awaiting_manual_payment_review'){pending.push({order_id:k,phone:v.phone,customer_name:v.customer_name||'?',items:v.items||[],total:v.grand_total||v.expected_total||0,ongkir:v.ongkir||0,courier:v.courier_label||v.courier||'?',ocr_amount:v.bukti_amount||0,expected_amount:v.expected_total||v.grand_total||0,bukti_url:v.bukti_url||null,bukti_bank:v.bukti_bank||null,match_status:v.payment_match_status||null,created_at:v.created_at||null})}}console.log(JSON.stringify(pending));"],
        { timeout: 10000 }, (err, stdout, stderr) => {
          if (err) return res.status(500).json({ error: String(stderr || err.message).slice(0, 200) });
          try {
            const pending = JSON.parse(stdout.trim().split(/\r?\n/).pop());
            // Also check drafts for awaiting_manual_payment_review
            const fs2 = require("fs");
            const draftsDir = "/opt/sbsr/data/openclaw/.openclaw/workspace/drafts";
            if (fs2.existsSync(draftsDir)) {
              const files = fs2.readdirSync(draftsDir).filter(f => f.endsWith(".json") && !f.includes("backup"));
              for (const f of files) {
                try {
                  const d = JSON.parse(fs2.readFileSync(draftsDir + "/" + f, "utf8"));
                  if ((d.state === "awaiting_manual_payment_review" || d.payment_review_state === "awaiting_manual_payment_review") && !pending.find(p => p.phone === d.phone)) {
                    pending.push({
                      order_id: d.entry_id || null,
                      phone: d.phone,
                      customer_name: d.customer_name || "?",
                      items: d.items || [],
                      total: d.grand_total || d.expected_total || 0,
                      ongkir: d.ongkir || 0,
                      courier: d.courier_label || d.courier || "?",
                      ocr_amount: d.bukti_amount || 0,
                      expected_amount: d.expected_total || d.grand_total || 0,
                      bukti_url: d.bukti_url || null,
                      bukti_bank: d.bukti_bank || null,
                      match_status: d.payment_match_status || null,
                      created_at: d.created_at || null,
                    });
                  }
                } catch (_) {}
              }
            }
            res.json(pending);
          } catch (e) { res.status(500).json({ error: "parse error: " + e.message }); }
        }
      );
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get("/admin/api/chat/:phone", (req, res) => { try { res.json(getChat(req.params.phone)); } catch (e) { res.status(400).json({ error: e.message }); } });

  // CSV export for one customer's full chat. GET → goes through basicAuth
  // (csrf middleware skips GET — see csrf() above), so the browser can fetch
  // it with the same Basic auth session as the rest of /admin.
  app.get("/admin/api/chat/:phone/csv", (req, res) => {
    try {
      const chat = getChat(req.params.phone);
      const body = chatToCsv(chat);
      res.set("Content-Type", "text/csv; charset=utf-8");
      res.set("Content-Disposition", 'attachment; filename="' + csvFilename(chat) + '"');
      res.set("Cache-Control", "no-store");
      res.send(body);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post("/admin/api/pause", express.json(), async (req, res) => {
    try {
      const phone = safePhone(req.body.phone);
      await setPaused(phone, !!req.body.paused);
      res.json({ ok: true, phone, paused: !!req.body.paused });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post("/admin/api/mark-read", express.json(), async (req, res) => {
    try {
      const phone = safePhone(req.body.phone);
      await markChatRead(phone);
      res.json({ ok: true, phone });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post("/admin/api/send", express.json(), async (req, res) => {
    try {
      const phone = safePhone(req.body.phone);
      const text = String(req.body.text || "").trim();
      if (!text) return res.status(400).json({ error: "empty text" });
      if (process.env.ADMIN_DRY_RUN === "1") {
        await logOutgoing(phone, "[DRY RUN] " + text);
        return res.json({ ok: true, dryRun: true });
      }
      const wa = await sendText(phone, text, undefined, { adminRelay: true, source: "admin" });
      // logOutgoing happens inside sendWhatsAppMessage wrapper; avoid double-log here
      res.json({ ok: true, wa });
    } catch (e) {
      res.status(400).json({ error: e.message, hint: "If 24h window expired, use a template message from Meta Business Manager." });
    }
  });

    app.get("/admin/api/token", (req, res) => {
    res.json({ token: process.env.OPENCLAW_TOKEN || "" });
  });

  console.log("[admin] panel mounted at /admin");
}

const express = require("express");

module.exports = { logIncoming, logOutgoing, isPaused, setPaused, listChats, getChat, stats, safePhone, markChatRead, mount };
