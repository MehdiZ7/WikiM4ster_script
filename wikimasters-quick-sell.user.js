// ==UserScript==
// @name         WikiMasters - Vente rapide
// @namespace    https://wiki-masters.com/
// @version      1.0.0
// @description  Met une carte en vente en un clic depuis ta collection : overlay "Vendre", prix de depart et duree. Apprend puis rejoue la requete du site.
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
    STORAGE_KEY: 'wm_quicksell_prefs_v1',
    DEFAULT_PRICE: 10,
    DEFAULT_DURATION: 24,
    DEFAULT_UNIT: 3600,
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
      window.WMQS_LAST = listingTemplates[0];
      log('captured listing request', url);
    } catch (e) {}
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
        else onStatus('Ench\u00e8re lanc\u00e9e !', false);
      })
      .catch(function (e) { onStatus('Erreur r\u00e9seau : ' + (e && e.message), true); });
  }

  function loadPrefs() {
    let p = {};
    try { p = JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY) || '{}'); } catch (e) {}
    CONFIG.DEFAULT_PRICE = typeof p.price === 'number' ? p.price : CONFIG.DEFAULT_PRICE;
    CONFIG.DEFAULT_DURATION = typeof p.duration === 'number' ? p.duration : CONFIG.DEFAULT_DURATION;
    CONFIG.DEFAULT_UNIT = typeof p.unit === 'number' ? p.unit : CONFIG.DEFAULT_UNIT;
  }

  function savePrefs() {
    if (!ui) return;
    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({
        price: Number(ui.root.getElementById('qsPrice').value) || CONFIG.DEFAULT_PRICE,
        duration: Number(ui.root.getElementById('qsDur').value) || CONFIG.DEFAULT_DURATION,
        unit: Number(ui.root.getElementById('qsUnit').value) || CONFIG.DEFAULT_UNIT
      }));
    } catch (e) {}
  }

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'wm-quicksell-host';
    host.style.cssText = 'all:initial;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      ':host{all:initial}' +
      '.launch{position:fixed;left:14px;bottom:14px;z-index:2147483646;padding:9px 14px;border-radius:99px;border:1px solid #3a5a3a;' +
        'background:#1f3a1f;color:#9fe29f;font-family:system-ui,Segoe UI,Roboto,sans-serif;font-size:13px;font-weight:700;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.5)}' +
      '.modal{display:none;position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.6);align-items:center;justify-content:center;padding:16px}' +
      '.dialog{background:#0c0d0c;color:#e7e7e7;border:1px solid #2a2d2a;border-radius:12px;padding:16px;width:min(340px,94vw);' +
        'display:flex;flex-direction:column;gap:9px;font-family:system-ui,Segoe UI,Roboto,sans-serif;box-shadow:0 20px 50px rgba(0,0,0,.6)}' +
      '.dtitle{font-size:15px;font-weight:700}' +
      '.dsub{font-size:11px;color:#8b918b;margin-top:-4px}' +
      '.lbl{font-size:10.5px;color:#8b918b;text-transform:uppercase;letter-spacing:.5px}' +
      'select,input{width:100%;box-sizing:border-box;background:#161916;border:1px solid #2a2d2a;border-radius:8px;color:#e7e7e7;padding:8px 10px;font-size:13px}' +
      'select:focus,input:focus{outline:none;border-color:#3a5a3a}' +
      '.quick{display:flex;gap:6px;flex-wrap:wrap}' +
      '.quick button{font-size:11px;padding:3px 9px;border-radius:8px;border:1px solid #2a2d2a;background:#161916;color:#cfd3cf;cursor:pointer}' +
      '.quick button.active{background:#243024;border-color:#3a5a3a;color:#fff}' +
      '.dur{display:flex;gap:6px}.dur input{flex:1}.dur select{flex:1}' +
      '.mrow{display:flex;gap:8px}' +
      '.mrow button{flex:1;font-size:13px;padding:9px;border-radius:8px;border:1px solid #3a5a3a;background:#243024;color:#fff;cursor:pointer}' +
      '.mrow #qsClose{background:#161916;color:#cfd3cf;border-color:#2a2d2a}' +
      '.sstatus{font-size:12px;color:#9aa09a;min-height:16px;word-break:break-word}' +
      '.learn{font-size:11px;color:#ffd166;line-height:1.5;background:#1a1708;border:1px solid #4a3d12;border-radius:8px;padding:8px}' +
      '</style>' +
      '<button class="launch" id="qsLaunch">\uFF0B Vendre une carte</button>' +
      '<div class="modal" id="qsModal">' +
      '  <div class="dialog">' +
      '    <div class="dtitle">Mettre une carte en vente</div>' +
      '    <div class="dsub" id="qsCardName"></div>' +
      '    <span class="lbl">Carte</span><select id="qsCard"></select>' +
      '    <span class="lbl">Prix de d\u00e9part</span><input id="qsPrice" type="number" min="1" value="' + CONFIG.DEFAULT_PRICE + '">' +
      '    <span class="lbl">Dur\u00e9e</span><div class="dur"><input id="qsDur" type="number" min="1" value="' + CONFIG.DEFAULT_DURATION + '"><select id="qsUnit">' +
      '      <option value="60">minutes</option><option value="3600">heures</option><option value="86400">jours</option></select></div>' +
      '    <div class="quick" id="qsQuick"></div>' +
      '    <div class="mrow"><button id="qsGo">Mettre en vente</button><button id="qsClose">Fermer</button></div>' +
      '    <div class="sstatus" id="qsStatus"></div>' +
      '  </div>' +
      '</div>';

    const launch = root.getElementById('qsLaunch');
    const modal = root.getElementById('qsModal');
    launch.addEventListener('click', function () { openForm(null); });
    root.getElementById('qsClose').addEventListener('click', function () { modal.style.display = 'none'; savePrefs(); });
    modal.addEventListener('click', function (e) { if (e.target === modal) { modal.style.display = 'none'; savePrefs(); } });

    const unitSel = root.getElementById('qsUnit');
    unitSel.value = String(CONFIG.DEFAULT_UNIT);
    root.getElementById('qsPrice').addEventListener('change', savePrefs);
    root.getElementById('qsDur').addEventListener('change', savePrefs);
    unitSel.addEventListener('change', savePrefs);

    const quick = root.getElementById('qsQuick');
    const presets = [{ l: '1 h', d: 1, u: 3600 }, { l: '6 h', d: 6, u: 3600 }, { l: '12 h', d: 12, u: 3600 }, { l: '24 h', d: 24, u: 3600 }, { l: '3 j', d: 3, u: 86400 }];
    for (const p of presets) {
      const b = document.createElement('button');
      b.textContent = p.l;
      b.addEventListener('click', function () {
        root.getElementById('qsDur').value = String(p.d);
        unitSel.value = String(p.u);
        savePrefs();
      });
      quick.appendChild(b);
    }

    root.getElementById('qsGo').addEventListener('click', function () {
      const status = root.getElementById('qsStatus');
      status.style.color = '#9aa09a';
      const id = root.getElementById('qsCard').value;
      const price = Number(root.getElementById('qsPrice').value);
      const dur = Number(root.getElementById('qsDur').value);
      const unit = Number(unitSel.value);
      if (!id) { status.style.color = '#ff6b6b'; status.textContent = 'Choisis une carte.'; return; }
      if (!price || price <= 0) { status.style.color = '#ff6b6b'; status.textContent = 'Indique un prix valide.'; return; }
      if (!dur || dur <= 0) { status.style.color = '#ff6b6b'; status.textContent = 'Indique une dur\u00e9e valide.'; return; }
      const card = (ownedCards || []).find(function (c) { return c.userCardId === id; });
      if (!card) { status.style.color = '#ff6b6b'; status.textContent = 'Carte introuvable.'; return; }
      savePrefs();
      if (!listingTemplates.length) {
        status.style.color = '#ffd166';
        status.textContent = 'Lis d\u2019abord le bloc jaune ci-dessus une fois.';
        return;
      }
      submitListing(card, price, dur * unit * 1000, function (msg, isErr) {
        status.style.color = isErr ? '#ff6b6b' : '#9fe29f';
        status.textContent = msg;
      });
    });

    document.documentElement.appendChild(host);
    ui = { host: host, root: root };
  }

  function ensureLearnNotice() {
    if (!ui) return;
    const dialog = ui.root.querySelector('.dialog');
    let el = ui.root.getElementById('qsLearn');
    if (listingTemplates.length) {
      if (el) el.remove();
      return;
    }
    if (!el) {
      el = document.createElement('div');
      el.id = 'qsLearn';
      el.className = 'learn';
      el.textContent = 'Pour activer la vente en 1 clic : fais UNE mise en vente manuelle (menu du site) avec ce script actif. Le script apprendra la requ\u00eate, puis tout sera automatique.';
      dialog.insertBefore(el, dialog.children[1] || null);
    }
  }

  function openForm(imageSrc, forcedCard) {
    if (!ui) return;
    const modal = ui.root.getElementById('qsModal');
    modal.style.display = 'flex';
    const sel = ui.root.getElementById('qsCard');
    const nameEl = ui.root.getElementById('qsCardName');
    const status = ui.root.getElementById('qsStatus');
    status.textContent = '';
    ensureLearnNotice();
    nameEl.textContent = '';
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
      let chosen = forcedCard || null;
      if (!chosen && imageSrc) {
        const m = imageSrc.match(/cards(?:%2F|\/)([^.?&/]+)/i);
        const slug = m && m[1] && m[1].toLowerCase();
        if (slug) chosen = cards.find(function (c) { return c.image && c.image.toLowerCase().indexOf(slug) !== -1; }) || null;
      }
      if (chosen) {
        sel.value = chosen.userCardId;
        nameEl.textContent = chosen.title + (chosen.rarity ? ' \u00b7 ' + chosen.rarity : '');
      }
      sel.onchange = function () {
        const c = cards.find(function (x) { return x.userCardId === sel.value; });
        nameEl.textContent = c ? (c.title + (c.rarity ? ' \u00b7 ' + c.rarity : '')) : '';
      };
    }).catch(function () {
      sel.innerHTML = '<option value="">Connecte-toi puis r\u00e9essaie</option>';
    });
  }

  function injectButtons() {
    try {
      if (!/collection|album|inventaire|inventory|cartes|profile|compte/i.test(location.pathname)) return;
      const imgs = document.querySelectorAll('img');
      for (const img of imgs) {
        const src = img.currentSrc || img.src || '';
        if (!/cards(%2F|\/)/i.test(src)) continue;
        const holder = img.parentElement;
        if (!holder || holder.querySelector('.wm-quick-sell-btn')) continue;
        if (getComputedStyle(holder).position === 'static') holder.style.position = 'relative';
        const btn = document.createElement('button');
        btn.className = 'wm-quick-sell-btn';
        btn.textContent = 'Vendre';
        btn.style.cssText = 'position:absolute;top:4px;right:4px;z-index:20;padding:3px 8px;border-radius:6px;' +
          'border:1px solid #3a5a3a;background:rgba(31,58,31,.95);color:#9fe29f;font-size:11px;font-weight:700;' +
          'cursor:pointer;font-family:system-ui,sans-serif;';
        btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();
          openForm(src, null);
        });
        btn.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
        holder.appendChild(btn);
      }
    } catch (e) {}
  }

  loadPrefs();
  hookFetch();
  hookXHR();

  function boot() {
    buildUI();
    setInterval(injectButtons, 2000);
    setTimeout(injectButtons, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  window.WMQS_LAST = listingTemplates[0] || null;
  window.WMQS_LISTINGS = function () { return listingTemplates; };
  window.WMQS_OWNED = function () { return fetchOwnedCards(); };
  window.WMQS_FORM = openForm;
  window.WMQS_SUBMIT = submitListing;
})();
