// ==UserScript==
// @name         WikiMasters - Vente rapide
// @namespace    https://wiki-masters.com/
// @version      2.1.0
// @description  Un bouton "Vendre 1 - 30 min" est pose au-dessus de chacune de tes cartes de collection : un clic = mise en vente. Apprend puis rejoue la requete du site.
// @author       you
// @match        https://www.wiki-masters.com/*
// @match        https://wiki-masters.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    PRICE: 1,
    MINUTES: 30,
    DEBUG: false
  };

  const SUPABASE_URL = 'https://cyrxjeppjqsxxjayfrur.supabase.co';
  const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN5cnhqZXBwanFzeHhqYXlmcnVyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM4ODAzMzksImV4cCI6MjA4OTQ1NjMzOX0.BZluyXygNxuQGDPxFX1zG5i-cqp10CVK-8GGtuak4Rg';

  let capturedAuth = null;
  let capturedApiKey = null;
  let listingTemplates = [];
  let ownedCards = null;
  let ownedPending = null;
  let ui = null;

  function log() {
    if (CONFIG.DEBUG) console.log('[WM-vente]', ...arguments);
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
    if (m.authorization && /^bearer /i.test(m.authorization)) capturedAuth = m.authorization;
    if (m.apikey) capturedApiKey = m.apikey;
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
    const h = { Authorization: bearer };
    const apikey = capturedApiKey || ANON_KEY;
    if (apikey) h.apikey = apikey;
    return h;
  }

  function looksLikeWrite(url, method) {
    if (!method || String(method).toUpperCase() === 'GET') return false;
    if (/rest\/v1|auction|marketplace|listing|sell|encher|\/api\/|rpc\//i.test(url || '')) return true;
    try {
      const u = new URL(url, location.href);
      if (u.origin === location.origin) return true;
    } catch (e) {}
    return false;
  }

  function isListingTemplate(t) {
    const s = (t.url || '') + ' ' + (t.body || '');
    return /auction|current_bid|end_at|listing|encher|card_?id|duration|duree|price|bid/i.test(s);
  }

  function recordListing(url, method, headers, body) {
    try {
      const entry = {
        url: url,
        method: String(method || 'POST').toUpperCase(),
        headers: headers || {},
        body: body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body)),
        ts: Date.now()
      };
      listingTemplates.unshift(entry);
      listingTemplates = listingTemplates.slice(0, 15);
      window.WMQS_LAST = listingTemplates[0];
      updateLauncher();
      log('captured write', url, isListingTemplate(entry) ? '(listing?)' : '');
    } catch (e) {}
  }

  function bestTemplate() {
    const listing = listingTemplates.filter(isListingTemplate);
    return listing[0] || listingTemplates[0] || null;
  }

  function hookFetch() {
    const original = window.fetch;
    if (!original) return;
    window.fetch = function () {
      const args = arguments;
      const first = args[0];
      const url = typeof first === 'string' ? first : (first && first.url) || '';
      const init = args[1] || {};
      const headers = init.headers || (first && first.headers);
      if (headers) captureHeaders(headers);
      const method = init.method || (first && first.method) || 'GET';
      if (looksLikeWrite(url, method)) {
        recordListing(url, method, headersToMap(headers), init.body != null ? init.body : null);
      }
      return original.apply(this, args);
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
      return origOpen.apply(this, arguments);
    };
    proto.send = function (body) {
      try {
        if (looksLikeWrite(this.__wmUrl, this.__wmMethod)) {
          recordListing(this.__wmUrl, this.__wmMethod, {}, body != null ? body : null);
        }
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
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
          });
          ownedPending = null;
          return ownedCards;
        });
      })
      .catch(function (e) { ownedPending = null; throw e; });
    return ownedPending;
  }

  function substitute(node, ctx) {
    if (!node || typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === 'object') { substitute(v, ctx); continue; }
      const key = String(k).toLowerCase();
      if (/user_?card/.test(key)) { node[k] = ctx.userCardId; continue; }
      if (/(^|_)card(_?id)?$/.test(key) && !/user/.test(key)) { node[k] = ctx.cardId; continue; }
      if (/(price|bid|amount|montant|prix|credit)/.test(key) && typeof v === 'number') { node[k] = ctx.price; continue; }
      if (/(end_?at|ends_?at|endat|expire|deadline|end_date)/.test(key)) { node[k] = ctx.endISO; continue; }
      if (/(duration|duree|length)/.test(key) && typeof v === 'number') {
        if (/minute|_min\b|mins/.test(key)) node[k] = ctx.minutes;
        else if (/hour|heure|_h\b|hrs/.test(key)) node[k] = Math.round(ctx.minutes / 60 * 100) / 100;
        else if (/second|seconde|_s\b|secs/.test(key)) node[k] = ctx.minutes * 60;
        else if (/day|jour/.test(key)) node[k] = Math.round(ctx.minutes / 1440 * 1000) / 1000;
        else if (v >= 600) node[k] = ctx.minutes * 60;
        else if (v <= 1) node[k] = Math.round(ctx.minutes / 60 * 100) / 100;
        else node[k] = ctx.minutes;
      }
    }
  }

  function submitListing(card, onStatus) {
    const tpl = bestTemplate();
    if (!tpl) {
      onStatus('Aucune requete apprise : fais UNE mise en vente manuelle (prix 1, duree 30 min) avec ce script actif.', true);
      return;
    }
    const ctx = {
      price: CONFIG.PRICE,
      minutes: CONFIG.MINUTES,
      cardId: card.cardId,
      userCardId: card.userCardId,
      endISO: new Date(Date.now() + CONFIG.MINUTES * 60000).toISOString()
    };
    let body = tpl.body;
    if (body) {
      try {
        const obj = JSON.parse(body);
        substitute(obj, ctx);
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
        if (res.status >= 400) onStatus('Erreur ' + res.status + ' : ' + res.text.slice(0, 180), true);
        else onStatus('Mise en vente OK (1 credit / 30 min).', false);
      })
      .catch(function (e) { onStatus('Erreur reseau : ' + (e && e.message), true); });
  }

  function normalizeTitle(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function slugToOwned(src, cards) {
    const m = String(src || '').match(/cards(?:%2F|\/)([^.?&/]+)/i);
    const slug = m && m[1] && m[1].toLowerCase();
    if (!slug) return null;
    return cards.find(function (c) { return c.image && c.image.toLowerCase().indexOf(slug) !== -1; }) || null;
  }

  function resolveCard(container) {
    if (!container) return null;
    const texts = [normalizeTitle(container.textContent)];
    const titled = container.querySelector('[title]');
    if (titled) texts.push(normalizeTitle(titled.getAttribute('title')));
    const srcImg = container.querySelector('img');
    if (srcImg) texts.push(normalizeTitle((srcImg.getAttribute('alt') || '')));
    let best = null;
    for (const tx of texts) {
      if (!tx) continue;
      for (const c of (ownedCards || [])) {
        const nt = normalizeTitle(c.title);
        if (nt.length >= 3 && tx.indexOf(nt) !== -1) {
          if (!best || nt.length > best.len) best = { card: c, len: nt.length };
        }
      }
    }
    return best ? best.card : null;
  }

  function toast(msg, isErr) {
    if (!ui) return;
    let t = ui.root.getElementById('qsToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'qsToast';
      t.style.cssText = 'position:fixed;left:50%;bottom:80px;transform:translateX(-50%);z-index:2147483647;' +
        'max-width:90vw;padding:10px 14px;border-radius:10px;font-family:system-ui,sans-serif;font-size:13px;' +
        'font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.5);transition:opacity .2s;';
      ui.root.appendChild(t);
    }
    t.textContent = msg;
    t.style.background = isErr ? '#3a1414' : '#1f3a1f';
    t.style.color = isErr ? '#ff9a9a' : '#9fe29f';
    t.style.opacity = '1';
    clearTimeout(t.__timer);
    t.__timer = setTimeout(function () { t.style.opacity = '0'; }, 3500);
  }

  function quickSell(container, img) {
    const src = img ? (img.currentSrc || img.src || '') : '';
    fetchOwnedCards().then(function (cards) {
      let card = resolveCard(container) || slugToOwned(src, cards);
      if (!card) {
        toast('Carte non identifiee : utilise le bouton \uFF0B Vendre.', true);
        return;
      }
      submitListing(card, function (msg, isErr) { toast(msg, isErr); });
    }).catch(function () {
      toast('Connecte-toi puis reessaie.', true);
    });
  }

  function attachCard(img) {
    const w = img.clientWidth || img.naturalWidth || 0;
    const h = img.clientHeight || img.naturalHeight || 0;
    if (w < 60 || h < 80) return;
    if (h <= w) return;
    const container = img.closest('a, li, article, figure') || img.parentElement;
    if (!container || container.querySelector('.wm-quick-sell-btn')) return;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    const btn = document.createElement('button');
    btn.className = 'wm-quick-sell-btn';
    btn.textContent = 'Vendre ' + CONFIG.PRICE + ' \u00b7 ' + CONFIG.MINUTES + ' min';
    btn.style.cssText = 'position:absolute;top:4px;left:50%;transform:translateX(-50%);z-index:30;' +
      'padding:5px 10px;border-radius:8px;border:1px solid #3a5a3a;background:rgba(31,58,31,.96);' +
      'color:#9fe29f;font-size:12px;font-weight:700;cursor:pointer;font-family:system-ui,sans-serif;white-space:nowrap;' +
      'box-shadow:0 3px 10px rgba(0,0,0,.5);';
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      quickSell(container, img);
    });
    btn.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
    container.appendChild(btn);
  }

  function scanCards() {
    try {
      if (/marketplace/i.test(location.pathname)) return;
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) attachCard(img);
    } catch (e) {}
  }

  function dumpCards() {
    try {
      const out = [];
      for (const img of document.querySelectorAll('img')) {
        const w = img.clientWidth || 0;
        const h = img.clientHeight || 0;
        if (w < 60 || h < 80 || h <= w) continue;
        const container = img.closest('a, li, article, figure') || img.parentElement;
        out.push({ src: (img.currentSrc || img.src || '').slice(0, 120), w: w, h: h, html: container ? container.outerHTML.slice(0, 600) : null });
        if (out.length >= 4) break;
      }
      console.log(JSON.stringify(out, null, 1));
      return out;
    } catch (e) { return []; }
  }

  function updateLauncher() {
    if (!ui) return;
    const l = ui.root.getElementById('qsLaunch');
    if (!l) return;
    const ready = !!bestTemplate();
    l.textContent = ready ? ('\uFF0B Vendre ' + CONFIG.PRICE + ' \u00b7 ' + CONFIG.MINUTES + ' min') : '\uFF0B Vendre (1 mise en vente manuelle requise)';
    l.style.borderColor = ready ? '#3a5a3a' : '#7a5a1a';
    l.style.color = ready ? '#9fe29f' : '#ffd166';
  }

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'wm-quicksell-host';
    host.style.cssText = 'all:initial;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.launch{position:fixed;left:14px;bottom:14px;z-index:2147483646;padding:9px 14px;border-radius:99px;' +
        'border:1px solid #3a5a3a;background:#1f3a1f;color:#9fe29f;font-family:system-ui,Segoe UI,Roboto,sans-serif;' +
        'font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.5)}' +
      '.modal{display:none;position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.6);align-items:center;justify-content:center;padding:16px}' +
      '.dialog{background:#0c0d0c;color:#e7e7e7;border:1px solid #2a2d2a;border-radius:12px;padding:16px;width:min(340px,94vw);' +
        'display:flex;flex-direction:column;gap:9px;font-family:system-ui,Segoe UI,Roboto,sans-serif}' +
      '.dtitle{font-size:15px;font-weight:700}' +
      '.lbl{font-size:10.5px;color:#8b918b;text-transform:uppercase;letter-spacing:.5px}' +
      'select{width:100%;box-sizing:border-box;background:#161916;border:1px solid #2a2d2a;border-radius:8px;color:#e7e7e7;padding:8px 10px;font-size:13px}' +
      '.mrow{display:flex;gap:8px}.mrow button{flex:1;font-size:13px;padding:9px;border-radius:8px;border:1px solid #3a5a3a;background:#243024;color:#fff;cursor:pointer}' +
      '.mrow #qsClose{background:#161916;color:#cfd3cf;border-color:#2a2d2a}' +
      '.sstatus{font-size:12px;color:#9aa09a;min-height:16px;word-break:break-word}' +
      '.learn{font-size:11px;color:#ffd166;line-height:1.5;background:#1a1708;border:1px solid #4a3d12;border-radius:8px;padding:8px}' +
      '</style>' +
      '<button class="launch" id="qsLaunch">\uFF0B Vendre</button>' +
      '<div class="modal" id="qsModal">' +
      '  <div class="dialog">' +
      '    <div class="dtitle">Vendre 1 \u00b7 30 min</div>' +
      '    <div class="learn" id="qsLearn">Fais UNE mise en vente manuelle (prix 1, duree 30 min) avec ce script actif : il apprendra la requete, puis le survol des cartes suffira.</div>' +
      '    <span class="lbl">Carte</span><select id="qsCard"></select>' +
      '    <div class="mrow"><button id="qsGo">Mettre en vente</button><button id="qsClose">Fermer</button></div>' +
      '    <div class="sstatus" id="qsStatus"></div>' +
      '  </div>' +
      '</div>';

    root.getElementById('qsLaunch').addEventListener('click', function () { openForm(); });
    root.getElementById('qsClose').addEventListener('click', function () {
      root.getElementById('qsModal').style.display = 'none';
    });
    root.getElementById('qsModal').addEventListener('click', function (e) {
      if (e.target === this) this.style.display = 'none';
    });
    root.getElementById('qsGo').addEventListener('click', function () {
      const status = root.getElementById('qsStatus');
      status.style.color = '#9aa09a';
      const id = root.getElementById('qsCard').value;
      const card = (ownedCards || []).find(function (c) { return c.userCardId === id; });
      if (!card) { status.style.color = '#ff6b6b'; status.textContent = 'Choisis une carte.'; return; }
      submitListing(card, function (msg, isErr) {
        status.style.color = isErr ? '#ff9a9a' : '#9fe29f';
        status.textContent = msg;
        toast(msg, isErr);
      });
    });

    document.documentElement.appendChild(host);
    ui = { host: host, root: root };
    updateLauncher();
  }

  function openForm() {
    if (!ui) return;
    const modal = ui.root.getElementById('qsModal');
    modal.style.display = 'flex';
    ui.root.getElementById('qsLearn').style.display = bestTemplate() ? 'none' : 'block';
    const sel = ui.root.getElementById('qsCard');
    sel.innerHTML = '<option>Chargement...</option>';
    fetchOwnedCards().then(function (cards) {
      sel.innerHTML = '';
      if (!cards.length) { sel.innerHTML = '<option value="">Aucune carte trouvee</option>'; return; }
      cards.sort(function (a, b) { return String(a.title).localeCompare(String(b.title)); });
      for (const c of cards) {
        const opt = document.createElement('option');
        opt.value = c.userCardId;
        opt.textContent = c.title + (c.rarity ? ' [' + c.rarity + ']' : '');
        sel.appendChild(opt);
      }
    }).catch(function () {
      sel.innerHTML = '<option value="">Connecte-toi puis reessaie</option>';
    });
  }

  hookFetch();
  hookXHR();

  function boot() {
    buildUI();
    setInterval(scanCards, 1500);
    setInterval(updateLauncher, 2000);
    setTimeout(scanCards, 800);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.WMQS_LAST = listingTemplates[0] || null;
  window.WMQS_LISTINGS = function () { return listingTemplates; };
  window.WMQS_BEST = bestTemplate;
  window.WMQS_OWNED = function () { return fetchOwnedCards(); };
  window.WMQS_FORM = openForm;
  window.WMQS_SUBMIT = submitListing;
  window.WMQS_DUMP = dumpCards;
})();
