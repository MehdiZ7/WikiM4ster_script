// ==UserScript==
// @name         WikiMasters - Encheres qui expirent bientot
// @namespace    https://wiki-masters.com/
// @version      1.14.0
// @description  Encheres se terminant bientot (fenetres, raretes, prix, recherche), prix moyen, mises en vente directes (bouton Vendre sur les cartes de collection + formulaire prix/duree), preferences memorisees, largeur adaptative et reglages economes sur mobile. Sans son.
// @author       you
// @match        https://www.wiki-masters.com/*
// @match        https://wiki-masters.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const IS_MOBILE = /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk/i.test(
    (typeof navigator !== 'undefined' && navigator.userAgent) || ''
  );

  const CONFIG = {
    MIN_SECONDS: 0,
    MAX_SECONDS: 120,
    TICK_MS: 1000,
    QUERY_MS: IS_MOBILE ? 15000 : 5000,
    QUERY_LIMIT: IS_MOBILE ? 300 : 1000,
    PRICE_MS: IS_MOBILE ? 120000 : 30000,
    ANNOTATE_MS: IS_MOBILE ? 10000 : 3000,
    DEBUG: false,
    STORAGE_KEY: 'wm_soon_auctions_v1',
    PREFS_KEY: 'wm_prefs_v1'
  };

  const SUPABASE_URL = 'https://cyrxjeppjqsxxjayfrur.supabase.co';
  const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5cnhqZXBwanFzeHhqYXlmcnVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4ODAzMzksImV4cCI6MjA4OTQ1NjMzOX0.BZluyXygNxuQGDPxFX1zG5i-cqp10CVK-8GGtuak4Rg';

  const END_KEYS = ['end_at', 'ends_at', 'endAt', 'end_time', 'endTime', 'expires_at'];
  const ID_KEYS = ['id', 'auction_id', 'auctionId'];
  const CARD_KEYS = ['cards', 'card', 'card_data', 'cardData'];
  const BID_KEYS = ['current_bid', 'currentBid', 'bid', 'price', 'current_price'];
  const RARITY_LABELS = {
    C: 'Commun', PC: 'Peu commun', R: 'Rare', SR: 'Super rare',
    UR: 'Ultra rare', L: 'Legendaire'
  };

  const store = new Map();
  const priceCache = {};
  let capturedAuth = null;
  let capturedApiKey = null;
  let lastAuctionsUrl = null;
  let listingTemplates = [];
  let ownedCards = null;
  let ownedPending = null;
  const debug = { requests: 0, jsonOk: 0, jsonFail: 0, lastStatus: '-', lastError: '-', lastRows: '-', lastUpdate: 0, loading: false };

  function log() {
    if (CONFIG.DEBUG) console.log('[WM-auctions]', ...arguments);
  }

  function toEpochMs(value) {
    if (value == null) return null;
    if (typeof value === 'number' && isFinite(value)) {
      return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (/^\d+$/.test(trimmed)) {
        const n = Number(trimmed);
        return n < 1e12 ? n * 1000 : n;
      }
      const parsed = Date.parse(trimmed);
      if (!isNaN(parsed)) return parsed;
    }
    return null;
  }

  function firstFrom(obj, keys) {
    for (const k of keys) {
      if (obj[k] != null && obj[k] !== '') return obj[k];
    }
    return null;
  }

  function normalize(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const id = firstFrom(obj, ID_KEYS);
    if (id == null) return null;
    const endMs = toEpochMs(firstFrom(obj, END_KEYS));
    if (!endMs) return null;

    let card = null;
    for (const k of CARD_KEYS) {
      if (obj[k] && typeof obj[k] === 'object') { card = obj[k]; break; }
    }
    const source = card || obj;

    const cardId = obj.card_id || obj.cardId || (card && card.id) || null;

    return {
      id: String(id),
      cardId: cardId ? String(cardId) : null,
      endMs: endMs,
      title: source.wikipedia_title || source.title || source.name || obj.title || 'Carte inconnue',
      image: source.image_url || source.image || obj.image_url || null,
      rarity: source.rarity || obj.rarity || null,
      category: source.category || obj.category || null,
      atk: source.atk != null ? source.atk : null,
      def: source.def != null ? source.def : null,
      bid: firstFrom(obj, BID_KEYS) != null ? firstFrom(obj, BID_KEYS) : (source.current_bid != null ? source.current_bid : null),
      updatedAt: Date.now()
    };
  }

  function ingest(node) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) ingest(item);
      return;
    }
    if (typeof node !== 'object') return;

    const record = normalize(node);
    if (record) {
      const prev = store.get(record.id);
      if (prev) {
        if (record.bid == null) record.bid = prev.bid;
        if (!record.image) record.image = prev.image;
        if (record.title === 'Carte inconnue') record.title = prev.title;
      }
      store.set(record.id, record);
    }

    for (const key of Object.keys(node)) {
      const child = node[key];
      if (child && typeof child === 'object') ingest(child);
    }
  }

  function extractObjects(text) {
    const out = [];
    const re = /\\?"end_at\\?"/g;
    let match;
    while ((match = re.exec(text)) !== null) {
      const p = match.index;
      let start = -1;
      let depth = 0;
      for (let i = p; i >= 0; i--) {
        const c = text[i];
        if (c === '}') depth++;
        else if (c === '{') {
          if (depth === 0) { start = i; break; }
          depth--;
        }
      }
      if (start < 0) continue;
      let d = 0;
      let inStr = false;
      let esc = false;
      let end = -1;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') d++;
        else if (c === '}') {
          d--;
          if (d === 0) { end = i; break; }
        }
      }
      if (end < 0) continue;
      try {
        out.push(JSON.parse(text.slice(start, end + 1)));
      } catch (e) {}
      re.lastIndex = end;
    }
    return out;
  }

  function ingestText(text, url) {
    if (!text || typeof text !== 'string') return;
    if (!text.includes('end_at') && !text.includes('EndTime') && !/auction/i.test(url || '')) return;
    debug.requests++;
    let ok = false;
    try {
      ingest(JSON.parse(text));
      ok = true;
    } catch (e) {}
    if (!ok) {
      const found = extractObjects(text);
      for (const obj of found) ingest(obj);
      if (found.length === 0) {
        debug.jsonFail++;
        log('could not parse payload for', url);
        scheduleDebug();
        return;
      }
    }
    debug.jsonOk++;
    enrichCards();
    scheduleRender();
    scheduleDebug();
    log('ingested', url, 'store size', store.size);
  }

  function headersToMap(h) {
    const m = {};
    if (!h) return m;
    try {
      if (typeof Headers !== 'undefined' && h instanceof Headers) {
        h.forEach(function (v, k) { m[String(k).toLowerCase()] = v; });
      } else if (Array.isArray(h)) {
        for (const pair of h) m[String(pair[0]).toLowerCase()] = pair[1];
      } else {
        for (const k of Object.keys(h)) m[k.toLowerCase()] = h[k];
      }
    } catch (e) {}
    return m;
  }

  function captureHeaders(h) {
    const m = headersToMap(h);
    if (m.authorization && /^bearer /i.test(m.authorization)) {
      if (capturedAuth !== m.authorization) {
        capturedAuth = m.authorization;
        log('captured auth header');
        scheduleDebug();
      }
    }
    if (m.apikey) capturedApiKey = m.apikey;
  }

  const enrichPending = new Set();
  const enrichDone = new Set();
  function enrichCards() {
    const now = Date.now();
    const ids = [];
    for (const rec of store.values()) {
      if (rec.cardId && rec.title === 'Carte inconnue' && (rec.endMs - now) < 900000 &&
          !enrichDone.has(rec.cardId) && !enrichPending.has(rec.cardId)) {
        enrichPending.add(rec.cardId);
        ids.push(rec.cardId);
      }
    }
    if (!ids.length) return;
    const headers = { apikey: capturedApiKey || ANON_KEY };
    if (capturedAuth) headers.Authorization = capturedAuth;

    const chunks = [];
    for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));

    const done = function () { render(); persist(); };
    let chain = Promise.resolve();
    chunks.forEach(function (chunk) {
      chain = chain.then(function () {
        const url = SUPABASE_URL + '/rest/v1/cards?select=*&id=in.(' + chunk.join(',') + ')';
        return window.fetch(url, { headers: headers })
          .then(function (r) { return r.text(); })
          .then(function (t) {
            let rows = [];
            try { rows = JSON.parse(t); } catch (e) {}
            const byId = {};
            for (const row of rows) byId[String(row.id)] = row;
            for (const rec of store.values()) {
              const c = rec.cardId && byId[rec.cardId];
              if (!c) continue;
              rec.title = c.wikipedia_title || rec.title;
              rec.image = c.image_url || rec.image;
              rec.rarity = c.rarity || rec.rarity;
              rec.category = c.category || rec.category;
              if (c.atk != null) rec.atk = c.atk;
              if (c.def != null) rec.def = c.def;
              enrichDone.add(rec.cardId);
            }
            chunk.forEach(function (i) { enrichPending.delete(i); });
          })
          .catch(function () { chunk.forEach(function (i) { enrichPending.delete(i); }); });
      });
    });
    chain.then(done);
  }

  const pricePending = new Set();
  function refreshPrices() {
    const headers = { apikey: capturedApiKey || ANON_KEY };
    if (capturedAuth) headers.Authorization = capturedAuth;
    const now = Date.now();
    const ids = [];
    for (const rec of store.values()) {
      if (!rec.cardId) continue;
      if (rec.endMs - now > 3600000) continue;
      const cached = priceCache[rec.cardId];
      if (cached && now - cached.ts < 600000) continue;
      if (pricePending.has(rec.cardId)) continue;
      if (ids.indexOf(rec.cardId) === -1) ids.push(rec.cardId);
    }
    if (!ids.length) return;

    const chunks = [];
    for (let i = 0; i < ids.length; i += 40) chunks.push(ids.slice(i, i + 40));

    let chain = Promise.resolve();
    chunks.forEach(function (chunk) {
      chunk.forEach(function (id) { pricePending.add(id); });
      chain = chain.then(function () {
        const url = SUPABASE_URL + '/rest/v1/auctions?select=card_id,final_price' +
          '&final_price=not.is.null&card_id=in.(' + chunk.join(',') + ')&limit=1000';
        return window.fetch(url, { headers: headers })
          .then(function (r) { return r.text(); })
          .then(function (t) {
            let rows = [];
            try { rows = JSON.parse(t); } catch (e) {}
            const agg = {};
            for (const row of rows) {
              const cid = String(row.card_id);
              const p = Number(row.final_price);
              if (!isFinite(p)) continue;
              if (!agg[cid]) agg[cid] = { sum: 0, n: 0 };
              agg[cid].sum += p;
              agg[cid].n++;
            }
            const ts = Date.now();
            for (const cid of Object.keys(agg)) {
              priceCache[cid] = { avg: Math.round(agg[cid].sum / agg[cid].n), n: agg[cid].n, ts: ts };
            }
            chunk.forEach(function (id) {
              pricePending.delete(id);
              if (!agg[id] && !priceCache[id]) priceCache[id] = { avg: null, n: 0, ts: ts };
            });
            render();
          })
          .catch(function () { chunk.forEach(function (id) { pricePending.delete(id); }); });
      });
    });
  }

  function annotateSite() {
    try {
      const links = document.querySelectorAll('a[href*="/marketplace/"]');
      for (const link of links) {
        const m = (link.getAttribute('href') || '').match(/\/marketplace\/([0-9a-f-]{36})/i);
        if (!m) continue;
        const rec = store.get(m[1]);
        const pc = rec && rec.cardId ? priceCache[rec.cardId] : null;
        let badge = link.querySelector('.wm-avg-price');
        if (!pc || pc.avg == null) {
          if (badge) badge.remove();
          continue;
        }
        if (!badge) {
          badge = document.createElement('span');
          badge.className = 'wm-avg-price';
          badge.style.cssText = 'display:inline-block;margin-left:6px;padding:1px 6px;border-radius:6px;' +
            'background:#1f3a1f;color:#9fe29f;font-size:11px;font-weight:700;vertical-align:middle;' +
            'font-family:system-ui,sans-serif;pointer-events:none;';
          link.appendChild(badge);
        }
        badge.textContent = '~' + pc.avg;
        badge.title = 'Prix moyen constate : ' + pc.avg + ' (' + pc.n + ' ventes)';
      }
    } catch (e) {}
  }

  function looksLikeWrite(url, method) {
    if (!method || String(method).toUpperCase() === 'GET') return false;
    return /auction|marketplace|listing|sell|encher|\/api\//i.test(url || '');
  }

  function recordListing(url, method, headers, body) {
    try {
      listingTemplates.unshift({
        url: url,
        method: String(method || 'POST').toUpperCase(),
        headers: headers || {},
        body: body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
        ts: Date.now()
      });
      listingTemplates = listingTemplates.slice(0, 10);
      window.WM_LAST_LISTING = listingTemplates[0];
      log('captured listing request', url);
    } catch (e) {}
  }

  function fetchOwnedCards() {
    if (ownedCards) return Promise.resolve(ownedCards);
    if (ownedPending) return ownedPending;
    const headers = authHeaders();
    if (!headers) return Promise.reject(new Error('pas de jeton'));
    ownedPending = window.fetch(SUPABASE_URL + '/rest/v1/user_cards?select=*&limit=1000', { headers: headers })
      .then(function (r) { return r.text(); })
      .then(function (t) {
        let rows = [];
        try { rows = JSON.parse(t); } catch (e) {}
        if (!Array.isArray(rows)) rows = [];
        const cardIds = [];
        for (const r of rows) if (r.card_id && cardIds.indexOf(String(r.card_id)) === -1) cardIds.push(String(r.card_id));
        const map = {};
        const chunks = [];
        for (let i = 0; i < cardIds.length; i += 50) chunks.push(cardIds.slice(i, i + 50));
        let chain = Promise.resolve();
        chunks.forEach(function (ch) {
          chain = chain.then(function () {
            return window.fetch(SUPABASE_URL + '/rest/v1/cards?select=id,wikipedia_title,image_url,rarity&id=in.(' + ch.join(',') + ')', { headers: headers })
              .then(function (r) { return r.text(); })
              .then(function (tt) { try { JSON.parse(tt).forEach(function (c) { map[c.id] = c; }); } catch (e) {} });
          });
        });
        return chain.then(function () {
          ownedCards = rows.map(function (r) {
            const c = map[r.card_id] || {};
            return {
              userCardId: String(r.id),
              cardId: r.card_id ? String(r.card_id) : null,
              title: c.wikipedia_title || 'Carte inconnue',
              image: c.image_url || null,
              rarity: c.rarity || null
            };
          }).sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
          ownedPending = null;
          return ownedCards;
        });
      })
      .catch(function (e) { ownedPending = null; throw e; });
    return ownedPending;
  }

  function deepSubstitute(node, ctx) {
    if (!node || typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === 'object') { deepSubstitute(v, ctx); continue; }
      const key = String(k).toLowerCase();
      if (ctx.userCardId && /user_?card/.test(key)) node[k] = ctx.userCardId;
      else if (ctx.cardId && /(^|_)card(_?id)?$/.test(key) && !/user/.test(key)) node[k] = ctx.cardId;
      else if (/(price|bid|amount|montant|prix)/.test(key) && typeof v === 'number') node[k] = ctx.price;
      else if (/(end_?at|ends_?at|endat|expire|deadline|end_date)/.test(key)) node[k] = ctx.endISO;
      else if (/(duration|duree|length)/.test(key) && typeof v === 'number') node[k] = ctx.durationHours;
    }
  }

  function submitListing(card, price, durationMs, onStatus) {
    const tpl = listingTemplates[0];
    if (!tpl) {
      onStatus('Aucune requ\u00eate apprise. Fais UNE mise en vente manuelle (avec le script actif), puis r\u00e9essaie.', true);
      return;
    }
    const ctx = {
      price: Number(price),
      cardId: card.cardId,
      userCardId: card.userCardId,
      endISO: new Date(Date.now() + durationMs).toISOString(),
      durationHours: Math.round(durationMs / 3600000 * 100) / 100
    };
    let body = tpl.body;
    if (body) {
      try {
        const obj = JSON.parse(body);
        deepSubstitute(obj, ctx);
        body = JSON.stringify(obj);
      } catch (e) {
        body = body.replace(/((?:price|bid|current_bid|amount)=)[^&]*/gi, '$1' + ctx.price)
          .replace(/((?:end_at|ends_at|end|expire|deadline)=)[^&]*/gi, '$1' + encodeURIComponent(ctx.endISO));
      }
    }
    const headers = Object.assign({}, tpl.headers);
    onStatus('Envoi...', false);
    window.fetch(tpl.url, { method: tpl.method, headers: headers, body: body, credentials: 'include' })
      .then(function (r) { return r.text().then(function (t) { return { status: r.status, text: t }; }); })
      .then(function (res) {
        if (res.status >= 400) onStatus('Erreur ' + res.status + ' : ' + res.text.slice(0, 200), true);
        else { onStatus('Ench\u00e8re lanc\u00e9e !', false); setTimeout(function () { directQuery(true); }, 800); }
      })
      .catch(function (e) { onStatus('Erreur r\u00e9seau : ' + (e && e.message), true); });
  }

  function injectCollectionButtons() {
    try {
      if (!/collection|album|inventaire|inventory|cartes/i.test(location.pathname)) return;
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        const src = img.currentSrc || img.src || '';
        if (!/cards(%2F|\/)/i.test(src)) continue;
        const holder = img.parentElement;
        if (!holder || holder.querySelector('.wm-sell-btn')) continue;
        if (getComputedStyle(holder).position === 'static') holder.style.position = 'relative';
        const btn = document.createElement('button');
        btn.className = 'wm-sell-btn';
        btn.textContent = 'Vendre';
        btn.style.cssText = 'position:absolute;top:6px;right:6px;z-index:10;padding:3px 8px;border-radius:6px;' +
          'border:1px solid #3a5a3a;background:#1f3a1f;color:#9fe29f;font-size:11px;font-weight:700;' +
          'cursor:pointer;font-family:system-ui,sans-serif;';
        btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          openSellForm(src);
        });
        holder.appendChild(btn);
      }
    } catch (e) {}
  }

  function openSellForm(imageSrc) {
    if (!ui) return;
    const modal = ui.root.getElementById('modal');
    if (!modal) return;
    modal.style.display = 'flex';
    const sel = ui.root.getElementById('sellCard');
    const status = ui.root.getElementById('sellStatus');
    status.textContent = '';
    status.style.color = '#9aa09a';
    sel.innerHTML = '<option>Chargement...</option>';
    fetchOwnedCards().then(function (cards) {
      sel.innerHTML = '';
      if (!cards.length) { sel.innerHTML = '<option value="">Aucune carte trouv\u00e9e</option>'; return; }
      for (const c of cards) {
        const opt = document.createElement('option');
        opt.value = c.userCardId;
        opt.textContent = c.title + (c.rarity ? ' [' + c.rarity + ']' : '');
        sel.appendChild(opt);
      }
      if (imageSrc) {
        const m = imageSrc.match(/cards(?:%2F|\/)([^.?&]+)/i);
        const slug = m && m[1];
        if (slug) {
          const found = cards.find(function (c) { return c.image && c.image.toLowerCase().indexOf(slug.toLowerCase()) !== -1; });
          if (found) sel.value = found.userCardId;
        }
      }
    }).catch(function () {
      sel.innerHTML = '<option value="">Connecte-toi puis r\u00e9essaie</option>';
    });
  }

  function hookFetch() {
    const original = window.fetch;
    if (!original) return;
    window.fetch = function () {
      const args = arguments;
      const first = args[0];
      const requestUrl = typeof first === 'string'
        ? first
        : (first && first.url) || '';
      const initHeaders = args[1] && args[1].headers;
      if (initHeaders) captureHeaders(initHeaders);
      else if (first && first.headers && first.headers.forEach) captureHeaders(first.headers);
      if (/\/rest\/v1\/auctions/.test(requestUrl)) lastAuctionsUrl = requestUrl;
      const init = args[1] || {};
      const method = init.method || (first && first.method) || 'GET';
      if (looksLikeWrite(requestUrl, method)) {
        const hdrs = headersToMap(initHeaders || (first && first.headers));
        recordListing(requestUrl, method, hdrs, init.body != null ? init.body : null);
      }
      const promise = original.apply(this, args);
      promise.then(function (res) {
        try {
          if (!res || !res.clone) return;
          const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
          if (/json|text/i.test(ct) || /rest\/v1|supabase|auction/i.test(requestUrl)) {
            res.clone().text().then(function (t) { ingestText(t, requestUrl); }).catch(function () {});
          }
        } catch (e) {}
      }).catch(function () {});
      return promise;
    };
  }

  function hookXHR() {
    const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
    if (!proto) return;
    const origOpen = proto.open;
    const origSend = proto.send;
    const origSetHeader = proto.setRequestHeader;
    proto.setRequestHeader = function (name, value) {
      try {
        const n = String(name).toLowerCase();
        if (n === 'authorization') captureHeaders({ authorization: value });
        else if (n === 'apikey') captureHeaders({ apikey: value });
      } catch (e) {}
      return origSetHeader.apply(this, arguments);
    };
    proto.open = function (method, url) {
      this.__wmUrl = url;
      this.__wmMethod = method;
      try {
        if (/\/rest\/v1\/auctions/.test(String(url))) lastAuctionsUrl = String(url);
      } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    proto.send = function (body) {
      const xhr = this;
      try {
        if (looksLikeWrite(xhr.__wmUrl, xhr.__wmMethod)) {
          recordListing(xhr.__wmUrl, xhr.__wmMethod, {}, body != null ? body : null);
        }
      } catch (e) {}
      xhr.addEventListener('load', function () {
        try {
          if (xhr.responseType === '' || xhr.responseType === 'text') {
            ingestText(xhr.responseText, xhr.__wmUrl);
          } else if (xhr.responseType === 'json' && xhr.response) {
            ingestText(JSON.stringify(xhr.response), xhr.__wmUrl);
          }
        } catch (e) {}
      });
      return origSend.apply(this, arguments);
    };
  }

  function hookWebSocket() {
    const Orig = window.WebSocket;
    if (!Orig) return;
    function WMWebSocket() {
      const ws = new Orig(...arguments);
      ws.addEventListener('message', function (ev) {
        try {
          if (typeof ev.data === 'string') ingestText(ev.data, 'ws');
        } catch (e) {}
      });
      return ws;
    }
    WMWebSocket.prototype = Orig.prototype;
    for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) WMWebSocket[k] = Orig[k];
    window.WebSocket = WMWebSocket;
  }

  function loadPersisted() {
    try {
      const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      const now = Date.now();
      for (const rec of arr) {
        if (rec && rec.id && rec.endMs && rec.endMs > now) store.set(String(rec.id), rec);
      }
      log('loaded', store.size, 'persisted auctions');
    } catch (e) {}
  }

  function persist() {
    try {
      const now = Date.now();
      const arr = [...store.values()].filter(function (r) { return r.endMs > now - 60000; });
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(arr));
    } catch (e) {}
  }

  function savePrefs() {
    try {
      localStorage.setItem(CONFIG.PREFS_KEY, JSON.stringify({
        window: windowSel.label,
        rarity: [...raritySelected],
        priceMin: priceMin,
        priceMax: priceMax,
        searchText: searchText,
        sortMode: sortMode,
        queryLimit: queryLimit
      }));
    } catch (e) {}
  }

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(CONFIG.PREFS_KEY) || '{}');
      if (p.window) {
        const w = WINDOWS.find(function (x) { return x.label === p.window; });
        if (w) windowSel = w;
      }
      if (Array.isArray(p.rarity)) {
        raritySelected.clear();
        for (const r of p.rarity) if (RARITY_ORDER.indexOf(r) !== -1) raritySelected.add(r);
      }
      if (typeof p.priceMin === 'number') priceMin = p.priceMin;
      if (typeof p.priceMax === 'number') priceMax = p.priceMax;
      if (typeof p.searchText === 'string') searchText = p.searchText;
      if (p.sortMode === 'price' || p.sortMode === 'time') sortMode = p.sortMode;
      if (typeof p.queryLimit === 'number' && LIMITS.indexOf(p.queryLimit) !== -1) queryLimit = p.queryLimit;
      log('prefs loaded', p);
    } catch (e) {}
  }

  function remainingSeconds(rec, now) {
    return (rec.endMs - now) / 1000;
  }

  let ui = null;
  let renderQueued = false;
  const RARITY_ORDER = ['C', 'PC', 'R', 'SR', 'UR', 'L'];
  const RARITY_COLORS = {
    C: '#8b918b', PC: '#5cc8a7', R: '#5aa9e6',
    SR: '#b98cf0', UR: '#ff8c42', L: '#ffd166'
  };
  const raritySelected = new Set();
  let sortMode = 'time';
  const WINDOWS = [
    { label: '0-2 min', min: 0, max: 120 },
    { label: '1-2 min', min: 60, max: 120 },
    { label: '0-5 min', min: 0, max: 300 },
    { label: '0-10 min', min: 0, max: 600 },
    { label: 'Tout', min: 0, max: Infinity }
  ];
  let windowSel = WINDOWS[0];
  let priceMin = null;
  let priceMax = null;
  let queryLimit = CONFIG.QUERY_LIMIT;
  let searchText = '';
  const LIMITS = [100, 300, 1000, 2000];

  function normText(s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  function matchesSearch(rec) {
    if (!searchText) return true;
    const q = normText(searchText);
    return normText(rec.title).indexOf(q) !== -1 || normText(rec.category).indexOf(q) !== -1;
  }

  function fmtClock(seconds) {
    const s = Math.max(0, Math.round(seconds));
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'wm-auction-alert-host';
    host.style.cssText = 'position:fixed;right:12px;bottom:12px;width:min(380px,92vw);z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.box{position:relative;width:100%;max-height:90vh;display:flex;flex-direction:column;font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0c0d0c;color:#e7e7e7;border:1px solid #2a2d2a;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.6);overflow:hidden;box-sizing:border-box}' +
      '.head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;background:#141614}' +
      '.title{font-size:15px;font-weight:700;letter-spacing:.3px}' +
      '.count{font-size:12px;background:#243024;color:#9fe29f;border-radius:99px;padding:2px 9px;margin-left:8px}' +
      '.toggle{cursor:pointer;background:none;border:none;color:#9aa09a;font-size:13px}' +
      '.list{flex:1;overflow:auto}' +
      '.row{display:flex;gap:10px;align-items:center;padding:9px 14px;border-top:1px solid #1d201d;text-decoration:none;color:inherit;border-left:4px solid transparent}' +
      '.row:hover{background:#161916}' +
      '.row.hot{background:linear-gradient(90deg,#3a1414,#1a0d0d)}' +
      '.thumb{width:40px;height:54px;border-radius:5px;object-fit:cover;background:#222;flex:0 0 auto}' +
      '.meta{flex:1;min-width:0}' +
      '.nameline{display:flex;align-items:center;gap:6px}' +
      '.name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.badge{font-size:9px;font-weight:800;padding:1px 5px;border-radius:4px;color:#0c0d0c;flex:0 0 auto}' +
      '.sub{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin-top:3px}' +
      '.pill{font-size:10.5px;padding:1px 6px;border-radius:6px;font-weight:700}' +
      '.pill.bid{background:#1b2a3a;color:#7fc4ff}' +
      '.pill.avg{background:#1f3a1f;color:#9fe29f}' +
      '.soft{font-size:10.5px;color:#9aa09a}' +
      '.time{font-variant-numeric:tabular-nums;font-weight:700;font-size:14px;color:#ffd166;flex:0 0 auto}' +
      '.time.hot{color:#ff6b6b}' +
      '.time.done{font-size:10px;color:#7a7f7a;font-weight:600}' +
      '.row.expired{opacity:.55}' +
      '.section{padding:7px 14px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#7a7f7a;background:#111311;border-top:1px solid #1d201d}' +
      '.empty{padding:16px 14px;font-size:12.5px;color:#8b918b;line-height:1.6}' +
      '.controls{padding:10px 14px;border-top:1px solid #1d201d;display:flex;flex-direction:column;gap:9px}' +
      '.lbl{font-size:10.5px;color:#8b918b;text-transform:uppercase;letter-spacing:.5px}' +
      '.chips{display:flex;flex-wrap:wrap;gap:4px}' +
      '.chip{font-size:11px;padding:3px 9px;border-radius:99px;border:1px solid #2a2d2a;background:#161916;color:#cfd3cf;cursor:pointer}' +
      '.chip:hover{background:#1d201d}' +
      '.chip.active{background:#243024;border-color:#3a5a3a;color:#fff}' +
      '.sorts{display:flex;gap:6px;align-items:center;flex-wrap:wrap}' +
      '.sorts button{font-size:11px;padding:3px 9px;border-radius:8px;border:1px solid #2a2d2a;background:#161916;color:#cfd3cf;cursor:pointer}' +
      '.sorts button.active{background:#243024;border-color:#3a5a3a;color:#fff}' +
      '.search{width:100%;box-sizing:border-box;background:#161916;border:1px solid #2a2d2a;border-radius:8px;color:#e7e7e7;padding:6px 9px;font-size:12px}' +
      '.search:focus{outline:none;border-color:#3a5a3a}' +
      '.price{display:flex;align-items:center;gap:8px}' +
      '.price input{flex:1;background:#161916;border:1px solid #2a2d2a;border-radius:8px;color:#e7e7e7;padding:5px 9px;font-size:12px}' +
      '.price input:focus{outline:none;border-color:#3a5a3a}' +
      '.foot{display:flex;gap:8px;padding:10px 14px;border-top:1px solid #1d201d}' +
      '.foot button{flex:1;font-size:11.5px;padding:7px 8px;border-radius:8px;border:1px solid #2a2d2a;background:#161916;color:#cfd3cf;cursor:pointer}' +
      '.foot button:hover{background:#1d201d}' +
      '.foot button.active{background:#3a2a12;border-color:#7a5a1a;color:#ffd166}' +
      '.modal{display:none;position:absolute;inset:0;background:rgba(0,0,0,.65);z-index:5;align-items:center;justify-content:center;padding:12px}' +
      '.dialog{background:#141614;border:1px solid #2a2d2a;border-radius:12px;padding:14px;width:100%;display:flex;flex-direction:column;gap:7px;box-sizing:border-box}' +
      '.dtitle{font-size:13px;font-weight:700;margin-bottom:2px}' +
      '.dialog select,.dialog input{width:100%;box-sizing:border-box;background:#161916;border:1px solid #2a2d2a;border-radius:8px;color:#e7e7e7;padding:7px 9px;font-size:12px}' +
      '.dialog select:focus,.dialog input:focus{outline:none;border-color:#3a5a3a}' +
      '.dur{display:flex;gap:6px}.dur input{flex:1}.dur select{flex:1}' +
      '.mrow{display:flex;gap:8px;margin-top:2px}' +
      '.mrow button{flex:1;font-size:12px;padding:8px;border-radius:8px;border:1px solid #3a5a3a;background:#243024;color:#fff;cursor:pointer}' +
      '.mrow #sellClose{background:#161916;color:#cfd3cf;border-color:#2a2d2a}' +
      '.sstatus{font-size:11px;color:#9aa09a;min-height:14px;word-break:break-word}' +
      '.status{padding:7px 14px;font-size:10px;color:#6f756f;border-top:1px solid #1d201d;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '</style>' +
      '<div class="box">' +
      '  <div class="head" id="head">' +
      '    <div><span class="title">Encheres</span><span class="count" id="count">0</span></div>' +
      '    <button class="toggle" id="toggle">r\u00e9duire</button>' +
      '  </div>' +
      '  <div class="controls" id="controls"></div>' +
      '  <div class="list" id="list"></div>' +
      '  <div class="foot">' +
      '    <button id="sell">Vendre</button>' +
      '    <button id="pause">Pause</button>' +
      '    <button id="refresh">Actualiser</button>' +
      '    <button id="clear">Vider</button>' +
      '  </div>' +
      '  <div class="status" id="status">initialisation...</div>' +
      '  <div class="modal" id="modal">' +
      '    <div class="dialog">' +
      '      <div class="dtitle">Mettre une carte en vente</div>' +
      '      <span class="lbl">Carte</span><select id="sellCard"></select>' +
      '      <span class="lbl">Prix de d\u00e9part</span><input id="sellPrice" type="number" min="1" placeholder="ex : 500">' +
      '      <span class="lbl">Dur\u00e9e</span><div class="dur"><input id="sellDur" type="number" min="1" value="24"><select id="sellUnit"><option value="60">minutes</option><option value="3600" selected>heures</option><option value="86400">jours</option></select></div>' +
      '      <div class="mrow"><button id="sellGo">Mettre en vente</button><button id="sellClose">Fermer</button></div>' +
      '      <div class="sstatus" id="sellStatus"></div>' +
      '    </div>' +
      '  </div>' +
      '</div>';

    const controls = root.getElementById('controls');

    const chips = document.createElement('div');
    chips.className = 'chips';
    const allChip = document.createElement('button');
    allChip.className = 'chip' + (raritySelected.size === 0 ? ' active' : '');
    allChip.textContent = 'Toutes';
    allChip.addEventListener('click', function () {
      raritySelected.clear();
      refreshChips();
      savePrefs();
      render();
    });
    chips.appendChild(allChip);
    for (const r of RARITY_ORDER) {
      const b = document.createElement('button');
      b.className = 'chip' + (raritySelected.has(r) ? ' active' : '');
      b.textContent = r;
      b.dataset.r = r;
      if (RARITY_COLORS[r]) b.style.color = RARITY_COLORS[r];
      b.addEventListener('click', function () {
        if (raritySelected.has(r)) raritySelected.delete(r);
        else raritySelected.add(r);
        refreshChips();
        savePrefs();
        render();
      });
      chips.appendChild(b);
    }
    function refreshChips() {
      allChip.classList.toggle('active', raritySelected.size === 0);
      [...chips.querySelectorAll('button[data-r]')].forEach(function (c) {
        c.classList.toggle('active', raritySelected.has(c.dataset.r));
      });
    }
    controls.appendChild(chips);

    const sorts = document.createElement('div');
    sorts.className = 'sorts';
    const sortLabel = document.createElement('span');
    sortLabel.textContent = 'Trier :';
    sorts.appendChild(sortLabel);
    const sortDefs = [{ v: 'time', label: 'fin imminente' }, { v: 'price', label: 'prix' }];
    for (const def of sortDefs) {
      const b = document.createElement('button');
      b.className = sortMode === def.v ? 'active' : '';
      b.textContent = def.label;
      b.dataset.sort = def.v;
      b.addEventListener('click', function () {
        sortMode = def.v;
        [...sorts.querySelectorAll('button')].forEach(function (x) {
          x.classList.toggle('active', x.dataset.sort === sortMode);
        });
        savePrefs();
        render();
      });
      sorts.appendChild(b);
    }
    controls.appendChild(sorts);

    const wins = document.createElement('div');
    wins.className = 'sorts';
    const winLabel = document.createElement('span');
    winLabel.textContent = 'Fenetre :';
    wins.appendChild(winLabel);
    for (const def of WINDOWS) {
      const b = document.createElement('button');
      b.className = windowSel === def ? 'active' : '';
      b.textContent = def.label;
      b.dataset.win = def.label;
      b.addEventListener('click', function () {
        windowSel = def;
        [...wins.querySelectorAll('button')].forEach(function (x) {
          x.classList.toggle('active', x.dataset.win === windowSel.label);
        });
        savePrefs();
        render();
      });
      wins.appendChild(b);
    }
    controls.appendChild(wins);

    const loads = document.createElement('div');
    loads.className = 'sorts';
    const loadLabel = document.createElement('span');
    loadLabel.textContent = 'Charger :';
    loads.appendChild(loadLabel);
    for (const n of LIMITS) {
      const b = document.createElement('button');
      b.className = queryLimit === n ? 'active' : '';
      b.textContent = String(n);
      b.dataset.limit = String(n);
      b.addEventListener('click', function () {
        queryLimit = n;
        [...loads.querySelectorAll('button')].forEach(function (x) {
          x.classList.toggle('active', Number(x.dataset.limit) === queryLimit);
        });
        savePrefs();
        directQuery();
      });
      loads.appendChild(b);
    }
    controls.appendChild(loads);

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.className = 'search';
    searchInput.placeholder = 'Rechercher (nom, cat\u00e9gorie)...';
    searchInput.value = searchText;
    searchInput.addEventListener('input', function () {
      searchText = this.value.trim();
      savePrefs();
      render();
    });
    controls.appendChild(searchInput);

    const priceRow = document.createElement('div');
    priceRow.className = 'price';
    const minInput = document.createElement('input');
    minInput.type = 'number';
    minInput.min = '0';
    minInput.step = '1';
    minInput.placeholder = 'Prix min (optionnel)';
    if (priceMin != null) minInput.value = String(priceMin);
    minInput.addEventListener('input', function () {
      const v = this.value.trim();
      priceMin = v === '' ? null : Number(v);
      savePrefs();
      render();
    });
    const maxInput = document.createElement('input');
    maxInput.type = 'number';
    maxInput.min = '0';
    maxInput.step = '1';
    maxInput.placeholder = 'Prix max (optionnel)';
    if (priceMax != null) maxInput.value = String(priceMax);
    maxInput.addEventListener('input', function () {
      const v = this.value.trim();
      priceMax = v === '' ? null : Number(v);
      savePrefs();
      render();
    });
    priceRow.appendChild(minInput);
    priceRow.appendChild(maxInput);
    controls.appendChild(priceRow);

    root.getElementById('toggle').addEventListener('click', function () {
      const list = root.getElementById('list');
      const foot = root.querySelector('.foot');
      const hidden = list.style.display === 'none';
      list.style.display = hidden ? '' : 'none';
      foot.style.display = hidden ? '' : 'none';
      controls.style.display = hidden ? '' : 'none';
      this.textContent = hidden ? 'r\u00e9duire' : 'agrandir';
    });
    root.getElementById('clear').addEventListener('click', function () {
      store.clear();
      persist();
      render();
    });
    root.getElementById('refresh').addEventListener('click', function () { directQuery(true); });
    const pauseBtn = root.getElementById('pause');
    pauseBtn.addEventListener('click', function () {
      ui.paused = !ui.paused;
      pauseBtn.textContent = ui.paused ? 'Reprendre' : 'Pause';
      pauseBtn.classList.toggle('active', ui.paused);
      if (!ui.paused) render();
    });

    root.getElementById('sell').addEventListener('click', function () { openSellForm(null); });
    root.getElementById('sellClose').addEventListener('click', function () {
      root.getElementById('modal').style.display = 'none';
    });
    root.getElementById('sellGo').addEventListener('click', function () {
      const status = root.getElementById('sellStatus');
      status.style.color = '#9aa09a';
      const id = root.getElementById('sellCard').value;
      const price = Number(root.getElementById('sellPrice').value);
      const dur = Number(root.getElementById('sellDur').value);
      const unit = Number(root.getElementById('sellUnit').value);
      if (!id) { status.style.color = '#ff6b6b'; status.textContent = 'Choisis une carte.'; return; }
      if (!price || price <= 0) { status.style.color = '#ff6b6b'; status.textContent = 'Indique un prix valide.'; return; }
      if (!dur || dur <= 0) { status.style.color = '#ff6b6b'; status.textContent = 'Indique une dur\u00e9e valide.'; return; }
      const card = (ownedCards || []).find(function (c) { return c.userCardId === id; });
      if (!card) { status.style.color = '#ff6b6b'; status.textContent = 'Carte introuvable.'; return; }
      submitListing(card, price, dur * unit * 1000, function (msg, isErr) {
        status.style.color = isErr ? '#ff6b6b' : '#9fe29f';
        status.textContent = msg;
      });
    });

    document.documentElement.appendChild(host);
    ui = { host: host, root: root, hovering: false, built: false, paused: false };
    const listEl = root.getElementById('list');
    listEl.addEventListener('mouseenter', function () { ui.hovering = true; });
    listEl.addEventListener('mouseleave', function () { ui.hovering = false; render(); });
    scheduleDebug();
  }

  function render() {
    if (!ui) return;
    const now = Date.now();
    const min = windowSel.min;
    const max = windowSel.max;
    const showAll = max === Infinity;
    const hotThreshold = min + 20;

    const cutoff = now - 120000;
    for (const entry of store) {
      if (entry[1].endMs < cutoff) store.delete(entry[0]);
    }

    const all = [...store.values()]
      .map(function (rec) { return { rec: rec, left: remainingSeconds(rec, now) }; });

    const inWindow = all.filter(function (x) {
      return x.left >= 0 && (showAll || (x.left >= min && x.left <= max));
    });

    const active = inWindow.filter(function (x) {
      if (!matchesSearch(x.rec)) return false;
      if (raritySelected.size > 0 && !raritySelected.has(x.rec.rarity)) return false;
      const bid = x.rec.bid == null ? null : Number(x.rec.bid);
      if (bid == null) {
        if (priceMin != null || priceMax != null) return false;
        return true;
      }
      if (priceMin != null && !isNaN(priceMin) && bid < priceMin) return false;
      if (priceMax != null && !isNaN(priceMax) && bid > priceMax) return false;
      return true;
    });

    if (sortMode === 'price') {
      active.sort(function (a, b) {
        const pa = a.rec.bid == null ? -Infinity : Number(a.rec.bid);
        const pb = b.rec.bid == null ? -Infinity : Number(b.rec.bid);
        return pb - pa;
      });
    } else {
      active.sort(function (a, b) { return a.left - b.left; });
    }

    const list = ui.root.getElementById('list');
    ui.root.getElementById('count').textContent = String(active.length);

    let emptyHtml = '';
    if (active.length === 0) {
      const range = showAll ? 'a venir' : ('entre ' + fmtClock(min) + ' et ' + fmtClock(max));
      const filters = [];
      if (raritySelected.size) filters.push('raret\u00e9 ' + [...raritySelected].join('/'));
      if (priceMin != null && !isNaN(priceMin)) filters.push('prix \u2265 ' + priceMin);
      if (priceMax != null && !isNaN(priceMax)) filters.push('prix \u2264 ' + priceMax);
      emptyHtml = '<div class="empty">Aucune enchere ' + range +
        (filters.length ? ' (' + filters.join(', ') + ')' : '') + '.';
      if (store.size === 0) {
        emptyHtml += '<br>Ouvre la page <b>Marketplace</b> du site pour que les encheres soient capturees, puis laisse cet onglet ouvert.';
      } else {
        emptyHtml += '<br>Prochaines encheres (hors fenetre) ci-dessous.';
      }
      emptyHtml += '</div>';
    }

    const expired = all.filter(function (x) {
      if (x.left >= 0) return false;
      if (!matchesSearch(x.rec)) return false;
      if (raritySelected.size > 0 && !raritySelected.has(x.rec.rarity)) return false;
      return true;
    }).sort(function (a, b) { return b.left - a.left; });

    const upcoming = all.filter(function (x) {
      if (x.left < 0) return false;
      if (!showAll && x.left <= max) return false;
      if (!matchesSearch(x.rec)) return false;
      if (raritySelected.size > 0 && !raritySelected.has(x.rec.rarity)) return false;
      const bid = x.rec.bid == null ? null : Number(x.rec.bid);
      if (bid == null) return !(priceMin != null || priceMax != null);
      if (priceMin != null && !isNaN(priceMin) && bid < priceMin) return false;
      if (priceMax != null && !isNaN(priceMax) && bid > priceMax) return false;
      return true;
    }).sort(function (a, b) { return a.left - b.left; }).slice(0, 15);

    if ((ui.hovering || ui.paused) && ui.built) return;

    const scrollTop = list.scrollTop;
    const frag = document.createDocumentFragment();
    function makeRow(entry, isExpired) {
      const rec = entry.rec;
      const color = RARITY_COLORS[rec.rarity] || '#3a3f3a';
      const hot = !isExpired && entry.left <= hotThreshold;
      const a = document.createElement('a');
      a.className = 'row' + (hot ? ' hot' : '') + (isExpired ? ' expired' : '');
      a.style.borderLeftColor = color;
      a.href = '/marketplace/' + encodeURIComponent(rec.id);
      a.target = '_blank';
      a.rel = 'noopener';

      if (rec.image) {
        const img = document.createElement('img');
        img.className = 'thumb';
        img.src = rec.image;
        img.loading = 'lazy';
        img.style.boxShadow = '0 0 0 2px ' + color;
        img.onerror = function () { this.style.visibility = 'hidden'; };
        a.appendChild(img);
      }

      const meta = document.createElement('div');
      meta.className = 'meta';
      const nameline = document.createElement('div');
      nameline.className = 'nameline';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = rec.title;
      nameline.appendChild(name);
      if (rec.rarity) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = rec.rarity;
        badge.style.background = color;
        nameline.appendChild(badge);
      }
      const sub = document.createElement('div');
      sub.className = 'sub';
      let added = 0;
      if (rec.bid != null) {
        const s = document.createElement('span');
        s.className = 'pill bid';
        s.textContent = 'offre ' + rec.bid;
        sub.appendChild(s);
        added++;
      }
      const pc = rec.cardId ? priceCache[rec.cardId] : null;
      if (pc && pc.avg != null) {
        const s = document.createElement('span');
        s.className = 'pill avg';
        s.textContent = 'moy. ' + pc.avg + (pc.n ? ' (' + pc.n + ')' : '');
        sub.appendChild(s);
        added++;
      }
      if (rec.atk != null && rec.def != null) {
        const s = document.createElement('span');
        s.className = 'soft';
        s.textContent = 'atk ' + rec.atk + ' / def ' + rec.def;
        sub.appendChild(s);
        added++;
      }
      if (rec.category) {
        const s = document.createElement('span');
        s.className = 'soft';
        s.textContent = rec.category;
        sub.appendChild(s);
        added++;
      }
      if (added === 0) sub.textContent = RARITY_LABELS[rec.rarity] || 'enchere';
      meta.appendChild(nameline);
      meta.appendChild(sub);
      a.appendChild(meta);

      const time = document.createElement('div');
      time.className = 'time' + (hot ? ' hot' : '') + (isExpired ? ' done' : '');
      time.textContent = isExpired ? 'expir\u00e9e' : fmtClock(entry.left);
      a.appendChild(time);
      return a;
    }

    for (const entry of active) frag.appendChild(makeRow(entry, false));
    if (active.length === 0 && emptyHtml) {
      const tmp = document.createElement('div');
      tmp.innerHTML = emptyHtml;
      while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    }
    if (active.length === 0 && upcoming.length) {
      const head = document.createElement('div');
      head.className = 'section';
      head.textContent = '\u00c0 venir (' + upcoming.length + ')';
      frag.appendChild(head);
      for (const entry of upcoming) frag.appendChild(makeRow(entry, false));
    }
    if (expired.length) {
      const head = document.createElement('div');
      head.className = 'section';
      head.textContent = 'Expir\u00e9es (' + expired.length + ')';
      frag.appendChild(head);
      for (const entry of expired) frag.appendChild(makeRow(entry, true));
    }
    list.replaceChildren(frag);
    list.scrollTop = scrollTop;
    ui.built = true;
  }

  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function () { renderQueued = false; render(); });
  }

  let debugQueued = false;
  function scheduleDebug() {
    if (debugQueued || !ui) return;
    debugQueued = true;
    requestAnimationFrame(function () {
      debugQueued = false;
      const el = ui.root.getElementById('status');
      if (!el) return;
      let ago = '-';
      if (debug.lastUpdate) ago = Math.round((Date.now() - debug.lastUpdate) / 1000) + 's';
      el.textContent = 'jeton ' + (capturedAuth ? 'OK' : '-') +
        ' | HTTP ' + debug.lastStatus + ' | lignes ' + debug.lastRows +
        ' | stock ' + store.size + ' | maj ' + ago +
        (debug.lastError && debug.lastError !== '-' ? ' | ' + debug.lastError : '');
    });
  }

  function sessionToken() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && /^sb-.*-auth-token$/.test(key)) {
          const data = JSON.parse(localStorage.getItem(key));
          const token = data && (data.access_token || (data.currentSession && data.currentSession.access_token));
          if (token) return token;
        }
      }
    } catch (e) {}
    return null;
  }

  function authHeaders() {
    let bearer = capturedAuth;
    if (!bearer) {
      const token = sessionToken();
      if (token) bearer = 'Bearer ' + token;
    }
    if (!bearer) return null;
    const apikey = capturedApiKey || (SUPABASE_URL ? 'no-key' : '');
    const h = { Authorization: bearer };
    if (apikey && apikey !== 'no-key') h.apikey = apikey;
    return h;
  }

  function buildFilteredUrl(useEmbed, useFilters) {
    const now = Date.now();
    const params = ['select=' + (useEmbed ? '*,card:cards(*)' : '*')];
    params.push('order=end_at.asc');
    params.push('limit=' + queryLimit);
    const lowerMs = useFilters && windowSel.min > 0
      ? now + windowSel.min * 1000 - 2000
      : now - 2000;
    params.push('end_at=gt.' + encodeURIComponent(new Date(lowerMs).toISOString()));
    if (useFilters) {
      if (windowSel.max !== Infinity) {
        params.push('end_at=lt.' + encodeURIComponent(new Date(now + windowSel.max * 1000).toISOString()));
      }
      if (priceMin != null && !isNaN(priceMin)) params.push('current_bid=gte.' + priceMin);
      if (priceMax != null && !isNaN(priceMax)) params.push('current_bid=lte.' + priceMax);
      if (useEmbed && raritySelected.size) {
        params.push('card.rarity=in.(' + [...raritySelected].join(',') + ')');
      }

    }
    return SUPABASE_URL + '/rest/v1/auctions?' + params.join('&');
  }

  function setLoading(on, label) {
    debug.loading = on;
    if (!ui) return;
    const btn = ui.root.getElementById('refresh');
    if (!btn) return;
    if (on) {
      btn.dataset.old = btn.textContent;
      btn.textContent = label || '...';
      btn.style.opacity = '.6';
    } else {
      btn.textContent = 'Actualiser';
      btn.style.opacity = '';
    }
  }

  function directQuery(manual) {
    const headers = authHeaders();
    if (!headers) {
      debug.lastError = 'pas de jeton (connecte-toi)';
      scheduleDebug();
      log('no auth token captured yet');
      return;
    }
    if (manual) setLoading(true);

    const now = Date.now();
    const from = new Date(now - 2000).toISOString();
    const urls = [];

    urls.push(buildFilteredUrl(true, true));
    urls.push(buildFilteredUrl(false, true));
    if (lastAuctionsUrl) {
      try {
        const u = new URL(lastAuctionsUrl);
        u.searchParams.set('end_at', 'gt.' + from);
        u.searchParams.set('order', 'end_at.asc');
        u.searchParams.set('limit', String(queryLimit));
        if (!u.searchParams.has('select')) u.searchParams.set('select', '*');
        urls.push(u.toString());
      } catch (e) {}
    }
    urls.push(buildFilteredUrl(false, false));

    let idx = 0;
    const tryNext = function () {
      if (idx >= urls.length) {
        setLoading(false);
        scheduleDebug();
        return;
      }
      const url = urls[idx++];
      window.fetch(url, { headers: headers })
        .then(function (r) {
          debug.lastStatus = String(r.status);
          return r.text().then(function (t) {
            if (r.status >= 400) {
              let msg = t.slice(0, 160);
              try { msg = JSON.parse(t).message || msg; } catch (e) {}
              debug.lastError = r.status + ' ' + msg;
              scheduleDebug();
              if (r.status === 401 || r.status === 403) { setLoading(false); return; }
              return tryNext();
            }
            let rows = -1;
            try {
              const j = JSON.parse(t);
              if (Array.isArray(j)) rows = j.length;
              else if (j && typeof j.length === 'number') rows = j.length;
            } catch (e) {}
            debug.lastRows = rows;
            debug.lastUpdate = Date.now();
            debug.lastError = '-';
            setLoading(false);
            ingestText(t, url);
            scheduleDebug();
            render();
          });
        })
        .catch(function (e) {
          debug.lastError = String(e && e.message || e);
          setLoading(false);
          scheduleDebug();
          tryNext();
        });
    };
    tryNext();
  }

  function scanPage() {
    try {
      if (window.__next_f && Array.isArray(window.__next_f)) {
        let buf = '';
        for (const entry of window.__next_f) {
          if (Array.isArray(entry)) {
            for (const x of entry) if (typeof x === 'string') buf += x;
          }
        }
        if (buf.indexOf('end_at') !== -1) ingestText(buf, 'next_f');
      }
    } catch (e) {}
    try {
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const t = s.textContent;
        if (t && t.length < 2000000 && t.indexOf('end_at') !== -1) ingestText(t, 'inline');
      }
    } catch (e) {}
    render();
    scheduleDebug();
  }

  loadPersisted();
  loadPrefs();
  hookFetch();
  hookXHR();
  hookWebSocket();

  function boot() {
    buildUI();
    scanPage();
    setTimeout(scanPage, 2500);
    setTimeout(scanPage, 6000);
    setInterval(injectCollectionButtons, 3000);
    setTimeout(injectCollectionButtons, 1500);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  setInterval(function () { render(); }, CONFIG.TICK_MS);
  setInterval(persist, 5000);
  setInterval(directQuery, CONFIG.QUERY_MS || 10000);
  setInterval(refreshPrices, CONFIG.PRICE_MS);
  setInterval(annotateSite, CONFIG.ANNOTATE_MS);
  setTimeout(directQuery, 3000);
  setTimeout(refreshPrices, 8000);
  window.WM_AUCTIONS = store;
  window.WM_DIRECT_QUERY = directQuery;
  window.WM_DEBUG = debug;
  window.WM_PRICE_CACHE = priceCache;
  window.WM_REFRESH_PRICES = refreshPrices;
  window.WM_SAVE_PREFS = savePrefs;
  window.WM_GET_PREFS = function () {
    return {
      window: windowSel.label, rarity: [...raritySelected],
      priceMin: priceMin, priceMax: priceMax, searchText: searchText,
      sortMode: sortMode, queryLimit: queryLimit, mobile: IS_MOBILE
    };
  };
  window.WM_GET_AUTH = function () { return { auth: capturedAuth, apiKey: capturedApiKey, url: lastAuctionsUrl }; };
  window.WM_LAST_LISTING = listingTemplates[0] || null;
  window.WM_LISTINGS = function () { return listingTemplates; };
  window.WM_OWNED = function () { return fetchOwnedCards(); };
  window.WM_SELL_FORM = openSellForm;
  window.WM_SUBMIT_LISTING = submitListing;
})();
