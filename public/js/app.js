/* =========================================================================
   Visera — Frontend Application Logic
   API endpoints consumed:
     POST   /api/session                          body { userId? }
     POST   /api/watchlist/:userId                body { symbol, alertPrice? }
     DELETE /api/watchlist/:userId/:symbol
     PUT    /api/watchlist/:userId/:symbol/alert  body { alertPrice }
     GET    /api/changes/:userId
     POST   /api/ack/:userId/:symbol
     POST   /api/ack-all/:userId
   ========================================================================= */

const POLL_MS = 5000;
const BUCKET_ORD = ['significant', 'notable', 'new', 'quiet'];
const BUCKET_META = {
  significant: { label: 'Significant', cls: 'bucket-sig' },
  notable: { label: 'Notable', cls: 'bucket-notable' },
  new: { label: 'New / Unseen', cls: 'bucket-new' },
  quiet: { label: 'Quiet', cls: 'bucket-quiet' },
};

// ── State ──────────────────────────────────────────────────────────────────

let userId = null;
let pollTimer = null;

// WebSocket live-tick state
let ws = null;   // active WebSocket (or null)
let wsReconnTimer = null;   // pending reconnect setTimeout handle
let wsWatchedSyms = [];     // symbols currently subscribed on the socket
let wsInitialised = false;  // true after first successful /api/changes fetch

// ── Ticker combobox state ──────────────────────────────────────────────────
let ddSymbols = [];        // [{ symbol, name }] – full list from /api/symbols
let ddWatchlist = new Set(); // symbols already in the watchlist (excluded from dropdown)
let ddActive = -1;        // index of keyboard-highlighted item (-1 = none)
let ddOpen = false;

// ── Supabase Configuration ────────────────────────────────────────────────
// Configure your Supabase project credentials below, pass via window.ENV, or enter via the UI settings drawer
const savedSupaUrl = localStorage.getItem('visera_supabase_url');
const savedSupaKey = localStorage.getItem('visera_supabase_key');

const SUPABASE_URL = (window.ENV && window.ENV.SUPABASE_URL) || savedSupaUrl || 'https://mxbvojdxkqbugbunidjh.supabase.co';
const SUPABASE_ANON_KEY = (window.ENV && window.ENV.SUPABASE_ANON_KEY) || savedSupaKey || 'sb_publishable_ojvEGz8X-38nrlO66w9Kqg_Ijjy0BqG';

let supabaseClient = null;
if (window.supabase && typeof window.supabase.createClient === 'function' && !SUPABASE_URL.includes('YOUR_SUPABASE_PROJECT')) {
  try {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (err) {
    console.warn('[supabase] Client init deferred:', err.message);
  }
}

let currentUser = null;
let authMode = 'signin'; // 'signin' | 'signup'

// ── Boot ───────────────────────────────────────────────────────────────────

(async function boot() {
  await initAuth();
  userId = await initSession();
  if (!userId) return;
  await fetchAndRender();
  schedulePoll();
  initTickerCombo();        // kick off combobox setup (non-blocking)
  requestNotifyPermission(); // ask for browser notification permission
})();

// ── Browser Notifications ──────────────────────────────────────────────────

/**
 * Request browser notification permission once.
 * Called on boot; the browser will only show the prompt if status is 'default'.
 */
function requestNotifyPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// Dedupe guard: track last alert fire time per symbol to avoid spam
const alertCooldowns = {};
const ALERT_COOLDOWN_MS = 30000; // 30 seconds per symbol

/**
 * Fire a browser Push Notification (and a toast) when the server sends an
 * 'alert' frame — i.e. a price crossed the user's alert threshold or jumped
 * into the 'significant' bucket.
 *
 * Works even when the Visera tab is in the background.
 *
 * @param {{ symbol, price, bucket, score, reasons, pct }} msg
 */
function fireAlertNotification(msg) {
  var sym = msg.symbol || '?';
  var now = Date.now();

  // Dedupe: skip if we already alerted for this symbol within the cooldown window
  if (alertCooldowns[sym] && (now - alertCooldowns[sym]) < ALERT_COOLDOWN_MS) return;
  alertCooldowns[sym] = now;

  var price = msg.price != null ? fmtPrice(Number(msg.price)) : '—';
  var pct = msg.pct != null ? (Number(msg.pct) >= 0 ? '+' : '') + Number(msg.pct).toFixed(2) + '%' : '';
  var sigClass = msg.signalClassification;
  var topReason = (sigClass && sigClass.narrative)
    ? sigClass.narrative
    : (Array.isArray(msg.reasons) && msg.reasons.length ? shortR(msg.reasons[0]) : msg.bucket);

  var prefix = (sigClass && sigClass.type === 'idiosyncratic')
    ? ' Idiosyncratic '
    : (sigClass && sigClass.type === 'macro' ? ' [Macro] ' : ' ');
  var title = prefix + sym + ' @ ' + price + ' (' + pct + ')';
  var body = topReason;

  // 1. Browser push notification (works when tab is backgrounded)
  if ('Notification' in window && Notification.permission === 'granted') {
    var n = new Notification(title, {
      body: body,
      icon: '/favicon.ico',
      tag: 'visera-' + sym,   // replaces previous notification for same symbol
      renotify: true,
    });
    // Clicking the notification focuses the Visera tab
    n.onclick = function () { window.focus(); n.close(); };
    setTimeout(function () { n.close(); }, 8000);
  }

  // 2. Always also show the in-page alert toast (visible if tab is active)
  alertToast(sym, price, pct, topReason, msg.bucket);
}

// ── Ticker Combobox ────────────────────────────────────────────────────────

async function initTickerCombo() {
  try {
    const res = await api('/api/symbols');
    const data = await res.json();
    ddSymbols = Array.isArray(data.symbols) ? data.symbols : [];
  } catch (_) {
    ddSymbols = [];
  }

  const inp = document.getElementById('inp-symbol');
  const drop = document.getElementById('ticker-dropdown');
  const chev = document.getElementById('ticker-chevron-btn');

  // Open on focus
  inp.addEventListener('focus', function () {
    ddFilterAndRender(inp.value);
    ddSetOpen(true);
  });

  // Filter as user types
  inp.addEventListener('input', function () {
    ddActive = -1;
    ddFilterAndRender(inp.value);
    ddSetOpen(true);
  });

  // Keyboard navigation
  inp.addEventListener('keydown', function (e) {
    if (!ddOpen) {
      if (e.key === 'ArrowDown') { ddFilterAndRender(inp.value); ddSetOpen(true); }
      return;
    }
    const items = drop.querySelectorAll('.dd-item');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      ddActive = Math.min(ddActive + 1, items.length - 1);
      ddHighlight(items, ddActive);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      ddActive = Math.max(ddActive - 1, -1);
      ddHighlight(items, ddActive);
    } else if (e.key === 'Enter') {
      if (ddActive >= 0 && items[ddActive]) {
        e.preventDefault();
        ddSelectItem(items[ddActive], inp);
      }
      // If no item highlighted, let the form submit with whatever was typed
    } else if (e.key === 'Escape') {
      ddSetOpen(false);
    }
  });

  // Chevron toggle
  chev.addEventListener('mousedown', function (e) {
    e.preventDefault(); // prevent input losing focus
    if (ddOpen) {
      ddSetOpen(false);
    } else {
      inp.focus();
      ddFilterAndRender(inp.value);
      ddSetOpen(true);
    }
  });

  // Close when clicking outside
  document.addEventListener('mousedown', function (e) {
    const combo = document.querySelector('.ticker-combo');
    if (combo && !combo.contains(e.target)) {
      ddSetOpen(false);
    }
  });

  // Delegate clicks on dropdown items
  drop.addEventListener('mousedown', function (e) {
    e.preventDefault(); // prevent input losing focus
    const item = e.target.closest('.dd-item');
    if (item) ddSelectItem(item, inp);
  });
}

/**
 * Filter ddSymbols by query and rebuild the dropdown HTML.
 * Symbols already in the watchlist (ddWatchlist) are always excluded.
 */
function ddFilterAndRender(query) {
  const drop = document.getElementById('ticker-dropdown');
  const q = (query || '').trim().toUpperCase();

  // First exclude symbols already on the watchlist
  const available = ddSymbols.filter(function (s) {
    return !ddWatchlist.has(s.symbol);
  });

  let filtered;
  if (!q) {
    // Show all available (non-watchlisted) symbols when query is empty
    filtered = available;
  } else {
    filtered = available.filter(function (s) {
      return s.symbol.includes(q) || s.name.toUpperCase().includes(q);
    });
  }

  if (filtered.length === 0) {
    // Check if the query matches something that's already been added
    const alreadyAdded = q && ddSymbols.some(function (s) {
      return (s.symbol.includes(q) || s.name.toUpperCase().includes(q)) && ddWatchlist.has(s.symbol);
    });
    if (alreadyAdded) {
      drop.innerHTML = '<div class="dd-empty">Already in your watchlist.</div>';
    } else {
      drop.innerHTML =
        '<div class="dd-empty">No matches — press Enter to add <strong>' +
        esc(q || '…') + '</strong> anyway.</div>';
    }
    return;
  }

  drop.innerHTML = filtered.map(function (s) {
    const symHL = ddHighlightText(s.symbol, q);
    const nameHL = ddHighlightText(s.name, q);
    return (
      '<div class="dd-item" data-symbol="' + esc(s.symbol) + '" role="option" aria-selected="false">' +
      '<span class="dd-sym">' + symHL + '</span>' +
      '<span class="dd-name">' + nameHL + '</span>' +
      '</div>'
    );
  }).join('');
}

/**
 * Highlight the `query` substring inside `text` with a <mark> tag.
 * Case-insensitive; only the first match is highlighted.
 */
function ddHighlightText(text, query) {
  if (!query) return esc(text);
  const idx = text.toUpperCase().indexOf(query.toUpperCase());
  if (idx === -1) return esc(text);
  return (
    esc(text.slice(0, idx)) +
    '<mark>' + esc(text.slice(idx, idx + query.length)) + '</mark>' +
    esc(text.slice(idx + query.length))
  );
}

/**
 * Update active highlight class; scroll item into view.
 */
function ddHighlight(items, activeIdx) {
  items.forEach(function (el, i) {
    el.classList.toggle('active', i === activeIdx);
    if (i === activeIdx) el.scrollIntoView({ block: 'nearest' });
  });
}

/**
 * Select an item from the dropdown: put just the ticker symbol into the input.
 */
function ddSelectItem(itemEl, inp) {
  const sym = itemEl.dataset.symbol;
  if (sym) inp.value = sym;
  ddSetOpen(false);
  // Move focus to alert-price for a smooth UX
  document.getElementById('inp-alert').focus();
}

/**
 * Open or close the dropdown and keep aria-expanded in sync.
 */
function ddSetOpen(open) {
  ddOpen = open;
  ddActive = -1;
  const drop = document.getElementById('ticker-dropdown');
  const inp = document.getElementById('inp-symbol');
  const chev = document.getElementById('ticker-chevron-btn');
  if (!drop || !inp || !chev) return;
  drop.classList.toggle('open', open);
  inp.setAttribute('aria-expanded', String(open));
  chev.textContent = open ? '▲' : '▼';
}

// ── Session ────────────────────────────────────────────────────────────────

async function initSession() {
  // If user is authenticated with Supabase, use their permanent UUID
  if (currentUser && currentUser.id) {
    return currentUser.id;
  }

  const stored = localStorage.getItem('visera_userId');
  try {
    const res = await api('/api/session', {
      method: 'POST',
      body: JSON.stringify({ userId: stored || undefined }),
    });
    const data = await res.json();
    if (!data.userId) throw new Error('No userId');
    localStorage.setItem('visera_userId', data.userId);
    return data.userId;
  } catch (e) {
    setStatus('error', 'session failed');
    toast('Session error: ' + e.message);
    return null;
  }
}

// ── Polling ────────────────────────────────────────────────────────────────

// Rendering lock: prevents applyTick from patching stale DOM nodes while
// render() is replacing innerHTML. Set true during render, cleared after.
let isRendering = false;

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await fetchAndRender();
    schedulePoll();
  }, POLL_MS);
}

async function fetchAndRender() {
  try {
    const res = await api('/api/changes/' + userId);
    const data = await res.json();
    const changes = data.changes || [];

    // Lock ticks out while we replace the DOM
    isRendering = true;
    render(changes);
    isRendering = false;

    setStatus('live', 'updated ' + fmtTime());

    // Keep dropdown watchlist exclusion set in sync
    ddWatchlist = new Set(changes.map(function (c) { return c.symbol; }));

    // Update live stat counters on the Overview page
    updateOverviewStats(changes);

    // ── WebSocket bootstrap / resubscribe ──────────────────────────────────
    const syms = changes.map(function (c) { return c.symbol; });
    wsWatchedSyms = syms;

    if (!wsInitialised) {
      wsInitialised = true;
      wsConnect();
    } else {
      syncDirectBinanceStreams(syms);
      wsSend({ type: 'subscribe', symbols: syms, userId: userId }); // re-subscribe (list may have changed)
    }
  } catch (e) {
    isRendering = false;
    setStatus('error', 'fetch error');
    toast('Poll error: ' + e.message);
  }
}

// ── WebSocket ──────────────────────────────────────────────────────────────

const WS_RECONNECT_MS = 1500;

/**
 * Build a ws:// (or wss://) URL that mirrors the current page origin.
 */
function wsUrl() {
  var proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return proto + '://' + location.host + '/ws';
}

/**
 * Send a JSON message if the socket is open; silently drop otherwise.
 */
function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

/**
 * Update the #ws-status pill in the header.
 * @param {'live'|'reconnecting'|'polling'} state
 * @param {string} label
 */
function wsSetStatus(state, label) {
  var el = document.getElementById('ws-status');
  var tx = document.getElementById('ws-status-text');
  if (!el || !tx) return;
  el.className = state === 'live' ? 'ws-live' : (state === 'polling' ? 'ws-polling' : 'ws-reconnecting');
  tx.textContent = label;
}

// Map of direct client-side Binance WebSockets for USDT symbols
const directSockets = new Map();

/**
 * Ensures direct browser WebSockets are connected to Binance for any USDT symbols.
 * This guarantees real-time sub-second streaming ticks directly in the browser,
 * even when hosted on serverless environments like Vercel where backend WebSockets are unavailable.
 */
function syncDirectBinanceStreams(symbols) {
  if (!('WebSocket' in window)) return;
  const usdtSyms = (symbols || []).filter(function (s) {
    return typeof s === 'string' && s.toUpperCase().endsWith('USDT');
  }).map(function (s) { return s.toUpperCase(); });

  const activeSet = new Set(usdtSyms);

  // Close sockets no longer in watchlist
  for (const [sym, sock] of directSockets.entries()) {
    if (!activeSet.has(sym)) {
      try { sock.close(); } catch (_) { }
      directSockets.delete(sym);
    }
  }

  // Open sockets for newly added USDT pairs
  for (const sym of usdtSyms) {
    if (directSockets.has(sym)) continue;

    try {
      const streamUrl = 'wss://stream.binance.com:9443/ws/' + sym.toLowerCase() + '@ticker';
      const bws = new WebSocket(streamUrl);

      bws.addEventListener('open', function () {
        wsSetStatus('live', 'live (streaming)');
      });

      bws.addEventListener('message', function (event) {
        try {
          const d = JSON.parse(event.data);
          if (d && d.c) {
            const price = parseFloat(d.c);
            if (!isNaN(price) && price > 0) {
              applyTick({ symbol: sym, price: price });
            }
          }
        } catch (_) { }
      });

      bws.addEventListener('close', function () {
        directSockets.delete(sym);
        if (directSockets.size === 0 && (!ws || ws.readyState !== WebSocket.OPEN)) {
          wsSetStatus('polling', 'cloud feed');
        }
      });

      directSockets.set(sym, bws);
    } catch (_) { }
  }

  if (directSockets.size > 0) {
    wsSetStatus('live', 'live (streaming)');
  }
}

let wsFailCount = 0;

/**
 * Open the WebSocket and wire up all handlers.
 * In serverless environments (like Vercel), the backend socket /ws is not available.
 * If connecting fails twice, it gracefully falls back to 'cloud feed' status
 * and avoids spamming reconnect warnings since HTTP polling is active.
 */
function wsConnect() {
  // Sync client-side live streaming sockets for USDT symbols
  syncDirectBinanceStreams(wsWatchedSyms);

  // If on a serverless host with direct streams active, we are already live
  if (directSockets.size > 0) {
    wsSetStatus('live', 'live (streaming)');
  }

  // Prevent double-connect if called while a socket is already alive
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  clearTimeout(wsReconnTimer);

  // If server WebSocket failed repeatedly (e.g. serverless host), don't show orange warning
  if (wsFailCount >= 2) {
    if (directSockets.size > 0) {
      wsSetStatus('live', 'live (streaming)');
    } else {
      wsSetStatus('polling', 'cloud feed');
    }
    // Poll again later in case user switches environment
    wsReconnTimer = setTimeout(wsConnect, 15000);
    return;
  }

  wsSetStatus('reconnecting', 'connecting…');

  try {
    ws = new WebSocket(wsUrl());
  } catch (_) {
    ws = null;
    wsFailCount++;
    return;
  }

  ws.addEventListener('open', function () {
    wsFailCount = 0;
    wsSetStatus('live', 'live');
    wsSend({ type: 'subscribe', symbols: wsWatchedSyms, userId: userId });
  });

  ws.addEventListener('message', function (event) {
    var msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg && msg.type === 'tick' && msg.data) {
      if (!isRendering) applyTick(msg.data);
    }

    if (msg && msg.type === 'alert') {
      fireAlertNotification(msg);
    }
  });

  ws.addEventListener('close', function () {
    ws = null;
    wsFailCount++;

    if (directSockets.size > 0) {
      wsSetStatus('live', 'live (streaming)');
    } else if (wsFailCount >= 2) {
      wsSetStatus('polling', 'cloud feed');
    } else {
      wsSetStatus('reconnecting', 'connecting…');
    }

    const backoff = wsFailCount >= 2 ? 15000 : WS_RECONNECT_MS;
    wsReconnTimer = setTimeout(wsConnect, backoff);
  });

  ws.addEventListener('error', function () {
    try { ws.close(); } catch (_) { }
  });
}

/**
 * Surgical tick update: update ONLY the .cell-price and .cell-pct cells
 * for the matching [data-symbol] row.  No re-render, no re-scoring.
 * The pctMoveSinceLastSeen comes from the server (snapshot.pctMove) when
 * provided; if absent the cell keeps its current server-rendered value.
 *
 * @param {{ symbol: string, price: number, pctMove?: number }} snap
 */
function applyTick(snap) {
  var sym = snap && snap.symbol ? String(snap.symbol).toUpperCase() : null;
  if (!sym) return;

  // querySelector is fast enough; selector is specific
  var row = document.querySelector('.sym-row[data-symbol="' + sym + '"]');
  if (!row) return;

  var priceCell = row.querySelector('.cell-price');
  var pctCell = row.querySelector('.cell-pct');

  if (priceCell && snap.price != null && !isNaN(Number(snap.price))) {
    priceCell.textContent = fmtPrice(Number(snap.price));
  }

  // Update the pct cell: either from server pctMove, or compute live against row's baseline
  if (pctCell && snap.price != null && !isNaN(Number(snap.price))) {
    var pct = null;
    if (snap.pctMove != null && !isNaN(Number(snap.pctMove))) {
      pct = Number(snap.pctMove);
    } else if (row.dataset.baseline) {
      var base = parseFloat(row.dataset.baseline);
      if (!isNaN(base) && base > 0) {
        pct = ((Number(snap.price) - base) / base) * 100;
      }
    }

    if (pct != null && !isNaN(pct)) {
      var pctCls = pct > 0.001 ? 'pos' : pct < -0.001 ? 'neg' : 'flat';
      var pctArrow = pct > 0.001 ? '▲' : pct < -0.001 ? '▼' : '';
      pctCell.className = 'cell cell-pct ' + pctCls;
      pctCell.textContent = pctArrow + fmtPct(pct);
    }
  }

  // Briefly highlight the row so the user can see what changed
  row.classList.remove('tick-flash');
  // Force reflow to restart the animation
  void row.offsetWidth;
  row.classList.add('tick-flash');
}

// ── Render ─────────────────────────────────────────────────────────────────

function render(changes) {
  const feed = document.getElementById('feed');
  if (!changes || changes.length === 0) {
    feed.innerHTML = '<div class="empty-state">Watchlist is empty &mdash; add a ticker above.</div>';
    return;
  }

  const groups = {};
  for (const b of BUCKET_ORD) groups[b] = [];
  for (const c of changes) {
    const key = groups[c.bucket] !== undefined ? c.bucket : 'quiet';
    groups[key].push(c);
  }

  let html = '';
  for (const bucket of BUCKET_ORD) {
    const items = groups[bucket];
    if (!items.length) continue;
    const m = BUCKET_META[bucket];
    html +=
      '<div class="section-head ' + m.cls + '">' +
      '<span class="bucket-label">' + m.label + '</span>' +
      '<span class="bucket-count">' + items.length + '</span>' +
      '</div>' +
      '<ul class="symbol-list">';
    for (const item of items) html += buildRow(item, bucket);
    html += '</ul>';
  }

  feed.innerHTML = html;

  feed.querySelectorAll('.alert-input').forEach(function (inp) {
    inp.addEventListener('input', onAlertChange);
    inp.addEventListener('keydown', onAlertKey);
  });
}

function buildRow(item, bucket) {
  var m = BUCKET_META[bucket];
  var sym = item.symbol;
  var snap = item.snapshot;
  var price = snap && snap.price != null ? Number(snap.price) : NaN;
  var pct = Number(item.pctMoveSinceLastSeen || 0);
  var alert = item.alertPrice != null ? Number(item.alertPrice) : '';
  var reasons = Array.isArray(item.reasons) ? item.reasons : [];

  var priceStr = isNaN(price) ? '&mdash;' : fmtPrice(price);
  var pctStr = fmtPct(pct);
  var pctCls = pct > 0.001 ? 'pos' : pct < -0.001 ? 'neg' : 'flat';
  var pctArrow = pct > 0.001 ? '&#9650;' : pct < -0.001 ? '&#9660;' : '';

  var sigClass = item.signalClassification;
  var classBadge = '';
  var narrativeHtml = '';

  if (sigClass) {
    if (sigClass.type === 'idiosyncratic') {
      var excessStr = (sigClass.excessReturn >= 0 ? '+' : '') + sigClass.excessReturn.toFixed(1) + '%';
      classBadge = '<span class="reason-tag badge-idiosyncratic" title="' + esc(sigClass.narrative) + '">Idiosyncratic (' + excessStr + ')</span>';
      narrativeHtml = '<div class="signal-narrative text-idiosyncratic">' + esc(sigClass.narrative) + '</div>';
    } else if (sigClass.type === 'macro') {
      classBadge = '<span class="reason-tag badge-macro" title="' + esc(sigClass.narrative) + '">Macro-driven</span>';
      narrativeHtml = '<div class="signal-narrative text-macro">' + esc(sigClass.narrative) + '</div>';
    }
  }

  // Filter out raw narrative strings from reasons to prevent clutter
  var displayReasons = reasons.filter(function (r) {
    return !r.includes('while market was') && !r.includes('so was the market') && !r.includes('vs market');
  });

  var rHtml = '';
  if (classBadge) {
    rHtml += classBadge;
  }
  if (displayReasons.length > 0) {
    rHtml += displayReasons.map(function (r) {
      return '<span class="reason-tag" title="' + esc(r) + '">' + esc(shortR(r)) + '</span>';
    }).join('');
  } else if (!classBadge) {
    if (bucket === 'new') {
      rHtml = '<span class="reason-new">New symbol (unseen)</span>';
    } else {
      rHtml = '<span class="reason-quiet">Baseline tracked (quiet)</span>';
    }
  }

  if (narrativeHtml) {
    rHtml += narrativeHtml;
  }

  var alertVal = alert !== '' ? alert : '';

  var baselinePrice = (item.lastSeen && item.lastSeen.price != null)
    ? Number(item.lastSeen.price)
    : (snap && snap.prevClose != null ? Number(snap.prevClose) : price);

  return (
    '<li class="sym-row ' + m.cls + '" data-symbol="' + esc(sym) + '" data-baseline="' + (isNaN(baselinePrice) ? '' : baselinePrice) + '">' +
    '<div class="row-main">' +
    '<div class="cell cell-sym">' + esc(sym) + '</div>' +
    '<div class="cell cell-price">' + priceStr + '</div>' +
    '<div class="cell cell-pct ' + pctCls + '">' + pctArrow + pctStr + '</div>' +
    '<div class="cell cell-reasons">' + rHtml + '</div>' +
    '<div class="cell cell-alert">' +
    '<input class="alert-input" type="number" step="0.01" min="0" ' +
    'placeholder="alert" value="' + alertVal + '" ' +
    'data-orig="' + alertVal + '" data-sym="' + esc(sym) + '" />' +
    '<button class="alert-save" onclick="doAlertSave(this)" title="Save">&#10003;</button>' +
    '</div>' +
    '<div class="cell cell-actions">' +
    '<button class="seen-btn" onclick="doSeen(\'' + esc(sym) + '\')" title="Mark seen">&#10003;&nbsp;seen</button>' +
    '<button class="danger-ghost" onclick="doRemove(\'' + esc(sym) + '\')" title="Remove">&#10005;</button>' +
    '</div>' +
    '</div>' +
    '</li>'
  );
}

// ── Actions ────────────────────────────────────────────────────────────────

async function handleAddSymbol(e) {
  e.preventDefault();
  ddSetOpen(false);   // close dropdown before submitting
  var symEl = document.getElementById('inp-symbol');
  var alertEl = document.getElementById('inp-alert');
  var btn = document.getElementById('btn-add');
  // Take only the first token (guards against accidental extra text)
  var sym = symEl.value.trim().toUpperCase().split(/\s+/)[0];
  if (!sym) return;
  var ap = alertEl.value !== '' ? parseFloat(alertEl.value) : undefined;
  btn.disabled = true;
  try {
    var body = { symbol: sym };
    if (ap != null && !isNaN(ap)) body.alertPrice = ap;
    var res = await api('/api/watchlist/' + userId, { method: 'POST', body: JSON.stringify(body) });
    if (!res.ok) { var err = await res.json().catch(function () { return {}; }); throw new Error(err.error || 'HTTP ' + res.status); }
    symEl.value = ''; alertEl.value = ''; symEl.focus();
    // Refresh symbol list in case a new one was added
    try {
      const sr = await api('/api/symbols');
      const sd = await sr.json();
      if (Array.isArray(sd.symbols)) ddSymbols = sd.symbols;
    } catch (_) { }
    await fetchAndRender();
  } catch (err) { toast('Add failed: ' + err.message); }
  finally { btn.disabled = false; }
}

async function doRemove(sym) {
  try {
    var res = await api('/api/watchlist/' + userId + '/' + encodeURIComponent(sym), { method: 'DELETE' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await fetchAndRender();
  } catch (err) { toast('Remove failed: ' + err.message); }
}

async function doSeen(sym) {
  try {
    var res = await api('/api/ack/' + userId + '/' + encodeURIComponent(sym), { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await fetchAndRender();
  } catch (err) { toast('Ack failed: ' + err.message); }
}

async function handleMarkAll() {
  var btn = document.getElementById('btn-mark-all');
  btn.disabled = true;
  try {
    var res = await api('/api/ack-all/' + userId, { method: 'POST' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    await fetchAndRender();
  } catch (err) { toast('Mark-all failed: ' + err.message); }
  finally { btn.disabled = false; }
}

function onAlertChange(e) {
  var inp = e.currentTarget;
  var btn = inp.nextElementSibling;
  inp.value !== inp.dataset.orig
    ? btn.classList.add('visible')
    : btn.classList.remove('visible');
}

function onAlertKey(e) {
  var inp = e.currentTarget;
  var btn = inp.nextElementSibling;
  if (e.key === 'Enter' && btn.classList.contains('visible')) { btn.click(); return; }
  if (e.key === 'Escape') { inp.value = inp.dataset.orig; btn.classList.remove('visible'); inp.blur(); }
}

async function doAlertSave(btn) {
  var inp = btn.previousElementSibling;
  var sym = inp.dataset.sym;
  // Empty input → null (clears the alert). A zero value is treated the same
  // way because changeDetector requires alertPrice > 0 to fire.
  var ap = inp.value !== '' ? parseFloat(inp.value) : null;
  if (ap !== null && isNaN(ap)) { toast('Invalid alert price'); return; }
  btn.disabled = true;
  try {
    var res = await api('/api/watchlist/' + userId + '/' + encodeURIComponent(sym) + '/alert',
      { method: 'PUT', body: JSON.stringify({ alertPrice: ap }) });
    if (!res.ok) { var e = await res.json().catch(function () { return {}; }); throw new Error(e.error || 'HTTP ' + res.status); }
    inp.dataset.orig = inp.value;
    btn.classList.remove('visible');
    await fetchAndRender();
  } catch (err) { toast('Alert save failed: ' + err.message); }
  finally { btn.disabled = false; }
}

// ── API ────────────────────────────────────────────────────────────────────

function api(path, opts) {
  return fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
}

// ── Page switching ─────────────────────────────────────────────────────────

/**
 * Switch between 'overview' and 'watchlist' tab pages.
 * Updates the active tab button and shows the correct page div.
 * @param {'overview'|'watchlist'} name
 */
function switchPage(name) {
  var key = String(name || 'overview').toLowerCase();
  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(function (btn) {
    btn.classList.toggle('active', btn.id === 'tab-' + key);
  });
  // Show/hide pages
  document.querySelectorAll('.page').forEach(function (pg) {
    pg.classList.toggle('active', pg.id === 'page-' + key);
  });
  // Persist preference
  try { localStorage.setItem('visera_page', key); } catch (_) { }
}

// Restore last-visited tab on page load
(function () {
  try {
    var saved = (localStorage.getItem('visera_page') || '').toLowerCase();
    if (saved === 'watchlist' || saved === 'overview') switchPage(saved);
  } catch (_) { }
})();

/**
 * Refresh the live stat counters on the Overview page.
 * Called from fetchAndRender() every time the watchlist data is refreshed.
 * @param {Array} changes  The changes array from /api/changes
 */
function updateOverviewStats(changes) {
  var total = changes.length;
  var sigCnt = changes.filter(function (c) { return c.bucket === 'significant'; }).length;
  var alrts = changes.filter(function (c) { return c.alertPrice != null && c.alertPrice > 0; }).length;

  var elSym = document.getElementById('ov-stat-symbols');
  var elSig = document.getElementById('ov-stat-sig');
  var elAlrts = document.getElementById('ov-stat-alerts');

  if (elSym) elSym.textContent = total > 0 ? total : (ddSymbols.length ? ddSymbols.length : '13+');
  if (elSig) elSig.textContent = sigCnt || '0';
  if (elAlrts) elAlrts.textContent = alrts || '0';
}

// ── Status ─────────────────────────────────────────────────────────────────

function setStatus(state, text) {
  document.getElementById('pulse').className = 'pulse' + (state === 'live' ? ' live' : state === 'error' ? ' error' : '');
  document.getElementById('status-text').textContent = text;
}

// ── Toast ──────────────────────────────────────────────────────────────────

var toastTimer = null;
function toast(msg) {
  var el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.classList.remove('show'); }, 5000);
}

/**
 * Show a styled alert card in the bottom-left stack for signal/price crossings.
 * Each card auto-dismisses after 8 s; clicking it dismisses immediately.
 *
 * @param {string} sym      Ticker symbol
 * @param {string} price    Formatted price string
 * @param {string} pct      Formatted % change string  (e.g. '+2.35%')
 * @param {string} reason   Human-readable reason (already shortened)
 * @param {string} bucket   'significant' | 'notable' | etc.
 */
function alertToast(sym, price, pct, reason, bucket) {
  var stack = document.getElementById('alert-stack');
  if (!stack) return;

  var card = document.createElement('div');
  card.className = 'alert-card' + (bucket === 'significant' ? ' bucket-sig' : '');

  card.innerHTML =
    '<div class="alert-card-head">' +
    '<span class="alert-card-sym">' + esc(sym) + '</span>' +
    '<span class="alert-card-price">' + esc(price) + '</span>' +
    '<span class="alert-card-pct">' + esc(pct) + '</span>' +
    '</div>' +
    '<div class="alert-card-reason">' + esc(reason) + '</div>';

  card.addEventListener('click', function () { dismiss(card); });
  stack.appendChild(card);

  var dismissTimer = setTimeout(function () { dismiss(card); }, 8000);

  function dismiss(el) {
    clearTimeout(dismissTimer);
    if (el.parentNode) el.parentNode.removeChild(el);
  }
}

// ── Formatters ─────────────────────────────────────────────────────────────

function fmtPrice(n) {
  if (isNaN(n)) return '&mdash;';
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n) {
  if (isNaN(n) || Math.abs(n) < 0.001) return '0.00%';
  return Math.abs(n).toFixed(2) + '%';
}

function shortR(r) {
  return r
    .replace('Volatility-normalized price move', 'Vol-norm move')
    .replace('Volume anomaly detected', 'Vol anomaly')
    .replace('Crossed 52-week high', '52w high x')
    .replace('Crossed 52-week low', '52w low x')
    .replace(/Crossed alert price \(([^)]+)\)/, 'Alert @ $1');
}

function fmtTime() {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Supabase Authentication Handlers ───────────────────────────────────────

/**
 * Initialize current auth session and listen to user login/logout events.
 */
async function initAuth() {
  if (!supabaseClient) {
    updateUserUI(null);
    return;
  }

  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    currentUser = session && session.user ? session.user : null;
    updateUserUI(currentUser);

    supabaseClient.auth.onAuthStateChange(async (event, session) => {
      const prevId = userId;
      currentUser = session && session.user ? session.user : null;
      updateUserUI(currentUser);

      if (currentUser && currentUser.id !== prevId) {
        userId = currentUser.id;
        toast('Logged in as ' + currentUser.email);
        await fetchAndRender();
      } else if (!currentUser && prevId) {
        userId = await initSession();
        toast('Logged out — back to default watchlist');
        await fetchAndRender();
      }
    });
  } catch (err) {
    console.warn('[auth] Error initializing session:', err.message);
  }
}

/**
 * Updates the user avatar and profile pill in the header.
 */
function updateUserUI(user) {
  const btnAuth = document.getElementById('btn-open-auth');
  const userPill = document.getElementById('user-pill');
  const userInit = document.getElementById('user-avatar-initial');
  const userEmail = document.getElementById('user-display-email');

  if (!btnAuth || !userPill) return;

  if (user && user.email) {
    btnAuth.style.display = 'none';
    userPill.style.display = 'inline-flex';
    if (userInit) userInit.textContent = user.email.charAt(0).toUpperCase();
    if (userEmail) userEmail.textContent = user.email;
  } else {
    btnAuth.style.display = 'inline-block';
    userPill.style.display = 'none';
  }
}

function openAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.style.display = 'flex';
  setAuthFeedback('', '');
  switchAuthMode('signin');

  // Pre-fill config inputs if saved
  const cfgUrl = document.getElementById('cfg-supabase-url');
  const cfgKey = document.getElementById('cfg-supabase-key');
  if (cfgUrl && !cfgUrl.value) cfgUrl.value = localStorage.getItem('visera_supabase_url') || '';
  if (cfgKey && !cfgKey.value) cfgKey.value = localStorage.getItem('visera_supabase_key') || '';
}

function closeAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.style.display = 'none';
}

function handleModalOverlayClick(e) {
  if (e.target && e.target.id === 'auth-modal') {
    closeAuthModal();
  }
}

function switchAuthMode(mode) {
  authMode = mode;
  const tabSignIn = document.getElementById('btn-tab-signin');
  const tabSignUp = document.getElementById('btn-tab-signup');
  const title = document.getElementById('auth-modal-title');
  const subtitle = document.getElementById('auth-modal-subtitle');
  const submitBtn = document.getElementById('btn-auth-submit');

  if (tabSignIn && tabSignUp) {
    tabSignIn.classList.toggle('active', mode === 'signin');
    tabSignUp.classList.toggle('active', mode === 'signup');
  }

  if (mode === 'signin') {
    if (title) title.innerHTML = 'Sign In to Vis<span class="dot">E</span>ra';
    if (subtitle) subtitle.textContent = 'Save your private watchlist and sync anomaly alerts across devices.';
    if (submitBtn) submitBtn.innerHTML = 'Sign In &rarr;';
  } else {
    if (title) title.innerHTML = 'Create Vis<span class="dot">E</span>ra Account';
    if (subtitle) subtitle.textContent = 'Start tracking your personal financial anomalies with Supabase sync.';
    if (submitBtn) submitBtn.innerHTML = 'Create Account &rarr;';
  }

  setAuthFeedback('', '');
}

function setAuthFeedback(error, success) {
  const elErr = document.getElementById('auth-error');
  const elSucc = document.getElementById('auth-success');

  if (elErr) {
    elErr.style.display = error ? 'block' : 'none';
    elErr.textContent = error || '';
  }
  if (elSucc) {
    elSucc.style.display = success ? 'block' : 'none';
    elSucc.textContent = success || '';
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = (document.getElementById('auth-email').value || '').trim();
  const password = (document.getElementById('auth-password').value || '').trim();
  const submitBtn = document.getElementById('btn-auth-submit');

  if (!email || !password) return;

  if (!supabaseClient) {
    setAuthFeedback('Supabase credentials not configured yet. Please configure SUPABASE_URL and SUPABASE_ANON_KEY.', '');
    return;
  }

  submitBtn.disabled = true;
  setAuthFeedback('', '');

  try {
    if (authMode === 'signin') {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      closeAuthModal();
    } else {
      const { data, error } = await supabaseClient.auth.signUp({ email, password });
      if (error) throw error;
      if (data && data.user && data.session) {
        closeAuthModal();
      } else {
        setAuthFeedback('', 'Account created! Please check your email to confirm registration or sign in.');
      }
    }
  } catch (err) {
    setAuthFeedback(err.message || 'Authentication error', '');
  } finally {
    submitBtn.disabled = false;
  }
}

async function handleSignOut() {
  if (supabaseClient) {
    try {
      await supabaseClient.auth.signOut();
    } catch (_) { }
  }
  currentUser = null;
  updateUserUI(null);
  userId = await initSession();
  await fetchAndRender();
  toast('Signed out');
}

/**
 * Allows the user to enter their Supabase Project URL and Anon Key directly
 * in the UI settings drawer without modifying source files.
 */
function saveCustomSupabaseConfig() {
  const url = (document.getElementById('cfg-supabase-url').value || '').trim();
  const key = (document.getElementById('cfg-supabase-key').value || '').trim();

  if (!url || !key) {
    setAuthFeedback('Please enter both Supabase URL and Anon Key.', '');
    return;
  }

  try {
    localStorage.setItem('visera_supabase_url', url);
    localStorage.setItem('visera_supabase_key', key);
    if (window.supabase && typeof window.supabase.createClient === 'function') {
      supabaseClient = window.supabase.createClient(url, key);
      initAuth();
      setAuthFeedback('', 'Connected to Supabase! You can now Sign Up or Sign In.');
      toast('Supabase credentials saved');
    }
  } catch (err) {
    setAuthFeedback('Invalid Supabase configuration: ' + err.message, '');
  }
}


