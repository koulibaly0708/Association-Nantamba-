/* sw.js — service worker de l'Association Nantamba
   Objectif : que les pages et leurs bibliothèques (Firebase SDK, Chart.js, XLSX…) restent
   disponibles même si la connexion est coupée ou instable. Les données Firebase, elles,
   sont gérées par nantamba-offline.js. Pour forcer une mise à jour : changer VERSION. */
var VERSION = 'nantamba-v1';
var SHELL = ['./', 'index.html', 'adhesion.html', 'benevolat.html', 'espace-membre.html', 'espace-benevole-donateur.html', 'nantamba-offline.js'];
var CDN_HOSTS = ['www.gstatic.com', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(VERSION).then(function(c){
    return Promise.all(SHELL.map(function(u){
      return c.add(new Request(u, { cache: 'reload' })).catch(function(){});
    }));
  }).then(function(){ return self.skipWaiting(); }));
});

self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== VERSION; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

function timeout(p, ms){
  return new Promise(function(res, rej){
    var t = setTimeout(function(){ rej(new Error('timeout')); }, ms);
    p.then(function(v){ clearTimeout(t); res(v); }, function(e){ clearTimeout(t); rej(e); });
  });
}
/* Pages du site : réseau d'abord (contenu à jour), copie locale si le réseau échoue ou traîne */
function networkFirst(req){
  return caches.open(VERSION).then(function(cache){
    return timeout(fetch(req), 5000).then(function(res){
      if(res && res.ok){ cache.put(req, res.clone()); }
      return res;
    }).catch(function(err){
      return cache.match(req, { ignoreSearch: true }).then(function(hit){
        if(hit){ return hit; }
        if(req.mode === 'navigate'){ return cache.match('index.html').then(function(h){ if(h){ return h; } throw err; }); }
        throw err;
      });
    });
  });
}
/* Bibliothèques externes : copie locale tout de suite, mise à jour en arrière-plan */
function staleWhileRevalidate(req){
  return caches.open(VERSION).then(function(cache){
    return cache.match(req).then(function(hit){
      var net = fetch(req).then(function(res){
        if(res && (res.ok || res.type === 'opaque')){ cache.put(req, res.clone()); }
        return res;
      });
      if(hit){ net.catch(function(){}); return hit; }
      return net;
    });
  });
}

self.addEventListener('fetch', function(e){
  var req = e.request;
  if(req.method !== 'GET'){ return; }
  var url = new URL(req.url);
  if(url.origin === self.location.origin){
    e.respondWith(networkFirst(req));
  } else if(CDN_HOSTS.indexOf(url.hostname) !== -1){
    e.respondWith(staleWhileRevalidate(req));
  }
  /* tout le reste (Firebase Realtime Database, etc.) passe directement par le réseau */
});
