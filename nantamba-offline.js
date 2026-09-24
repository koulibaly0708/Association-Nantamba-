/* ============================================================
   nantamba-offline.js — résilience face aux coupures / à Firebase
   À placer dans le même dossier que les pages HTML.
   Apporte :
   1. Cache local des données lues (affichage instantané + affichage hors-ligne)
   2. Bandeau « hors connexion » et retour automatique en ligne
   3. File d'attente des envois (adhésion, bénévolat, dons) rejoués au retour du réseau
   4. Reconnexion hors-ligne aux espaces (code déjà validé sur cet appareil)
   5. Enregistrement du service worker (sw.js) : pages et bibliothèques disponibles hors-ligne
   ============================================================ */
(function(){
  'use strict';
  var P = 'an_off:';
  var TTL = 30 * 24 * 3600 * 1000;      // les données en cache expirent après 30 jours
  var MAX_ENTRY = 1500000;              // taille max d'une entrée (~1,5 Mo)
  var fb = null;                        // fonctions Firebase transmises par la page
  var mem = {};                         // dernières valeurs reçues en direct
  var active = {};                      // espaces connectés (membre, vol, don)
  var storeOn = false;
  var connected = null, downSince = 0, wasOffline = false, flushing = false;
  var afterHandlers = {};

  /* ---------- localStorage protégé ---------- */
  function lsGet(k){ try{ return localStorage.getItem(P + k); }catch(e){ return null; } }
  function lsSet(k, v){ try{ localStorage.setItem(P + k, v); return true; }catch(e){ return false; } }
  function lsDel(k){ try{ localStorage.removeItem(P + k); }catch(e){} }
  function jparse(s, d){ try{ return s ? JSON.parse(s) : d; }catch(e){ return d; } }

  /* ---------- état de la connexion ---------- */
  function isOnline(){
    if(navigator.onLine === false) return false;
    if(connected === false && Date.now() - downSince > 6000) return false;
    return true;
  }
  function isNetworkError(e){
    if(!isOnline()) return true;
    var m = String((e && (e.code || e.message)) || e);
    return /an\/timeout|offline|network|disconnect|unavailable|timeout/i.test(m);
  }
  function withTimeout(p, ms){
    return new Promise(function(resolve, reject){
      var t = setTimeout(function(){ var e = new Error('Délai dépassé'); e.code = 'an/timeout'; reject(e); }, ms);
      Promise.resolve(p).then(function(v){ clearTimeout(t); resolve(v); }, function(e){ clearTimeout(t); reject(e); });
    });
  }

  /* ---------- cache des lectures ---------- */
  function readCache(key){
    var o = jparse(lsGet('d:' + key), null);
    if(!o || typeof o.t !== 'number' || Date.now() - o.t > TTL) return undefined;
    return { v: o.v, t: o.t };
  }
  function persist(key){
    var m = mem[key]; if(!m) return;
    var s; try{ s = JSON.stringify({ t: Date.now(), v: m.v }); }catch(e){ return; }
    if(s.length > MAX_ENTRY) return;
    if(lsSet('d:' + key, s)){ lsSet('sync', String(Date.now())); }
  }
  function remember(key, val, opts){
    opts = opts || {};
    mem[key] = { v: opts.map ? opts.map(val) : val, pub: !!opts.pub };
    if(storeOn || opts.pub){ persist(key); }
  }
  function fakeSnap(v){
    return { val: function(){ return v; }, exists: function(){ return v != null; }, cached: true };
  }
  function keyOf(r, opts){
    if(opts && opts.key) return opts.key;
    return String(r).replace(/^https?:\/\/[^\/]+/, '');
  }
  function purge(){
    try{
      var del = [];
      for(var i = 0; i < localStorage.length; i++){
        var k = localStorage.key(i);
        if(k && k.indexOf(P + 'd:') === 0){ del.push(k); }
      }
      del.forEach(function(k){ localStorage.removeItem(k); });
    }catch(e){}
    mem = {};
  }

  /* ---------- API publique ---------- */
  var NO = {};

  NO.isOnline = isOnline;
  NO.timeout = withTimeout;

  /* Données personnelles : mises en cache seulement une fois connecté, effacées à la déconnexion */
  NO.enableStore = function(space){
    active[space || 'x'] = true; storeOn = true;
    Object.keys(mem).forEach(persist);
  };
  NO.disableStore = function(space){
    delete active[space || 'x'];
    if(Object.keys(active).length === 0){ storeOn = false; purge(); }
  };

  /* onValue avec cache : affiche d'abord la dernière copie locale, puis la donnée en direct */
  NO.onValue = function(r, cb, errCb, opts){
    var key = keyOf(r, opts), live = false, c = readCache(key);
    if(c){ setTimeout(function(){ if(!live){ cb(fakeSnap(c.v)); } }, 0); }
    return fb.onValue(r, function(snap){
      live = true;
      remember(key, snap.val(), opts);
      cb(snap);
    }, function(e){ if(errCb){ errCb(e); } else { console.warn(e); } });
  };

  /* get avec délai maximal et repli sur le cache (sauf refus de permission) */
  NO.get = function(r, opts){
    var key = keyOf(r, opts);
    return withTimeout(fb.get(r), 8000).then(function(snap){
      remember(key, snap.val(), opts);
      return snap;
    }).catch(function(e){
      var msg = String((e && (e.code || e.message)) || e);
      var c = readCache(key);
      if(c && !/permission/i.test(msg)){ return fakeSnap(c.v); }
      throw e;
    });
  };

  /* ---------- envois différés ---------- */
  function qRead(){ return jparse(lsGet('queue'), []); }
  function qWrite(a){ lsSet('queue', JSON.stringify(a)); updateBanner(); }
  function enqueue(path, data, kind, after){
    var q = qRead();
    if(q.some(function(i){ return i.path === path; })){ return; }
    q.push({ path: path, data: data, kind: kind || '', after: !!after, t: Date.now() });
    qWrite(q);
  }
  /* Enregistre path=data. Hors-ligne ou réseau trop lent : mis en file, envoyé plus tard.
     La clé est fixée à l'avance (push), donc un renvoi n'engendre jamais de doublon. */
  NO.safeSet = function(path, data, kind, opts){
    var after = !!(opts && opts.after);
    return new Promise(function(resolve, reject){
      var done = false;
      function queued(){ if(done) return; done = true; enqueue(path, data, kind, after); resolve({ queued: true }); }
      if(!isOnline()){ queued(); return; }
      var timer = setTimeout(queued, 10000);
      fb.set(fb.ref(fb.db, path), data).then(function(){
        clearTimeout(timer);
        if(done) return; done = true; resolve({ queued: false });
      }).catch(function(e){
        clearTimeout(timer);
        if(done) return;
        if(isNetworkError(e)){ queued(); } else { done = true; reject(e); }
      });
    });
  };
  NO.onSent = function(kind, fn){ afterHandlers[kind] = fn; };

  function flush(){
    if(flushing || !fb || !isOnline()) return;
    var q = qRead(); if(!q.length) return;
    flushing = true;
    (function next(i){
      if(i >= q.length){ flushing = false; updateBanner(); return; }
      var it = q[i];
      if(it.after && !afterHandlers[it.kind]){ next(i + 1); return; }   // traité par la page qui sait le faire
      withTimeout(fb.set(fb.ref(fb.db, it.path), it.data), 12000).catch(function(e){
        /* Les règles n'autorisent que la création : un refus signifie que la demande existe déjà (envoyée par le SDK) */
        if(/permission/i.test(String((e && (e.code || e.message)) || e))){ console.warn('Envoi déjà enregistré ou refusé', it.path); return; }
        throw e;
      }).then(function(){
        var cur = qRead().filter(function(x){ return x.path !== it.path; });
        qWrite(cur);
        if(it.after && afterHandlers[it.kind]){ try{ afterHandlers[it.kind](it); }catch(e){ console.error(e); } }
        next(i + 1);
      }).catch(function(e){ console.warn('Envoi différé reporté', e); flushing = false; });
    })(0);
  }

  /* ---------- reconnexion hors-ligne (empreinte salée, jamais le code en clair) ---------- */
  function b64(buf){ var s = ''; new Uint8Array(buf).forEach(function(b){ s += String.fromCharCode(b); }); return btoa(s); }
  function derive(space, code, salt){
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(space + ':' + code), 'PBKDF2', false, ['deriveBits'])
      .then(function(k){
        return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, k, 256);
      }).then(b64);
  }
  function canCrypto(){ return !!(window.crypto && crypto.subtle && window.TextEncoder); }
  function unb64(s){ var b = atob(s), a = new Uint8Array(b.length); for(var i = 0; i < b.length; i++){ a[i] = b.charCodeAt(i); } return a; }

  NO.rememberLogin = function(space, code, payload){
    if(!canCrypto()){ return Promise.resolve(); }
    var all = jparse(lsGet('login'), {});
    var list = all[space] || [];
    var salt = crypto.getRandomValues(new Uint8Array(16));
    return derive(space, code, salt).then(function(h){
      list = list.filter(function(e){ return e.h !== h; });
      /* même code déjà mémorisé avec un autre sel : on le retrouve et on le remplace */
      return Promise.all(list.map(function(e){ return derive(space, code, unb64(e.s)).then(function(x){ return x === e.h ? null : e; }); }))
        .then(function(kept){
          list = kept.filter(Boolean);
          list.unshift({ s: b64(salt), h: h, p: payload, t: Date.now() });
          all[space] = list.slice(0, 5);
          lsSet('login', JSON.stringify(all));
        });
    }).catch(function(e){ console.warn(e); });
  };
  NO.offlineLogin = function(space, code){
    if(!canCrypto()){ return Promise.resolve(null); }
    var list = (jparse(lsGet('login'), {})[space]) || [];
    return Promise.all(list.map(function(e){
      return derive(space, code, unb64(e.s)).then(function(h){ return h === e.h ? e.p : null; });
    })).then(function(r){ return r.filter(Boolean)[0] || null; }).catch(function(){ return null; });
  };
  NO.forgetLogin = function(space, code){
    if(!canCrypto()){ return Promise.resolve(); }
    var all = jparse(lsGet('login'), {});
    var list = all[space] || [];
    return Promise.all(list.map(function(e){
      return derive(space, code, unb64(e.s)).then(function(h){ return h === e.h ? null : e; });
    })).then(function(kept){ all[space] = kept.filter(Boolean); lsSet('login', JSON.stringify(all)); }).catch(function(){});
  };

  NO.forgetSpace = function(space){
    var all = jparse(lsGet('login'), {});
    if(all[space]){ delete all[space]; lsSet('login', JSON.stringify(all)); }
  };

  /* ---------- session serveur : ouvre les droits de lecture de l'espace ----------
     Le visiteur reçoit un compte anonyme Firebase ; les règles n'accordent la lecture qu'à un
     compte dont sessions/{uid}/{espace} contient un code encore actif dans accessIndex.
     Si un administrateur est déjà connecté sur ce navigateur, on ne touche à rien. */
  NO.openSession = function(space, data){
    if(!fb.auth || !fb.signInAnonymously){ return Promise.resolve(false); }
    var a = fb.auth;
    return withTimeout((a.authStateReady ? a.authStateReady() : Promise.resolve()).then(function(){
      return a.currentUser || fb.signInAnonymously(a).then(function(c){ return c.user; });
    }).then(function(u){
      if(!u){ return false; }
      if(!u.isAnonymous){ return true; }
      return fb.set(fb.ref(fb.db, 'sessions/' + u.uid + '/' + space), data).then(function(){ return true; });
    }), 10000).catch(function(e){ console.warn('session', e); return false; });
  };
  NO.closeSession = function(space){
    var u = fb.auth && fb.auth.currentUser;
    if(u && u.isAnonymous && fb.remove){
      fb.remove(fb.ref(fb.db, 'sessions/' + u.uid + '/' + space)).catch(function(){});
    }
  };

  /* ---------- bandeau d'état ---------- */
  function bar(){
    var el = document.getElementById('an-net-banner');
    if(el || !document.body){ return el; }
    el = document.createElement('div');
    el.id = 'an-net-banner';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:9px 14px;font:600 13px/1.4 system-ui,sans-serif;text-align:center;color:#fff;background:#7a4b00;display:none;';
    document.body.appendChild(el);
    return el;
  }
  function fmtSync(){
    var t = Number(lsGet('sync'));
    if(!t){ return ''; }
    try{ return new Date(t).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }catch(e){ return ''; }
  }
  function updateBanner(){
    var el = bar(); if(!el){ return; }
    var n = qRead().length, off = !isOnline();
    if(off){
      wasOffline = true;
      var s = fmtSync();
      el.style.background = '#7a4b00';
      el.textContent = '⚠ Hors connexion — les données affichées sont celles de la dernière synchronisation' + (s ? ' (' + s + ')' : '') + '.' + (n ? ' ' + n + ' envoi(s) en attente.' : '');
      el.style.display = 'block';
    } else if(n){
      el.style.background = '#2f5d8a';
      el.textContent = 'Envoi des données en attente… (' + n + ')';
      el.style.display = 'block';
    } else if(wasOffline){
      wasOffline = false;
      el.style.background = '#2f7d4f';
      el.textContent = '✓ Connexion rétablie';
      el.style.display = 'block';
      setTimeout(function(){ if(isOnline() && !qRead().length){ el.style.display = 'none'; } }, 2500);
    } else {
      el.style.display = 'none';
    }
  }

  /* ---------- initialisation (une fois par page) ---------- */
  NO.init = function(fns){
    fb = fns;
    if(fb.onValue && fb.ref && fb.db){
      fb.onValue(fb.ref(fb.db, '.info/connected'), function(s){
        var now = s.val() === true;
        if(!now && connected !== false){ downSince = Date.now(); setTimeout(updateBanner, 6100); }
        connected = now;
        updateBanner();
        if(now){ flush(); }
      });
    }
    window.addEventListener('online', function(){ updateBanner(); flush(); });
    window.addEventListener('offline', updateBanner);
    if(document.readyState === 'loading'){ document.addEventListener('DOMContentLoaded', updateBanner); } else { updateBanner(); }
    setTimeout(flush, 3000);
    setInterval(function(){ if(qRead().length){ flush(); } }, 60000);
    return NO;
  };

  /* ---------- service worker : pages et bibliothèques disponibles hors-ligne ---------- */
  if('serviceWorker' in navigator && /^https?:$/.test(location.protocol)){
    window.addEventListener('load', function(){ navigator.serviceWorker.register('sw.js').catch(function(e){ console.warn('sw', e); }); });
  }

  window.NantambaOffline = NO;
})();
