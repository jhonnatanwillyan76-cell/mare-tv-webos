// ============================================================
// Maré TV — LG webOS · js/ads.js
//
// Anúncios DENTRO da transmissão, iguais à TV/celular. Baixa /api/tv/ads,
// decide quando/onde mostrar (por canal/categoria e intervalo, ou "Exibir
// agora" do painel) e desenha por cima/ao lado do vídeo. 5 formatos:
// overlay · lower_third · lshape · split · squeeze.
//
// O ÁUDIO da transmissão NUNCA é tocado: o <video> principal segue o mesmo,
// só muda o retângulo dele na tela (formatos "shrink") ou o anúncio entra por
// cima (formatos "overlay"). O criativo em vídeo entra SEMPRE mudo.
//
// ES5 puro (sem arrow/template/let/const) — roda no Chromium antigo do webOS.
// ============================================================

var MareAds = (function () {
  'use strict';

  var BASE = 'https://maretv.vercel.app';

  var ads = [];
  var current = null;
  var seenShowNow = {}; // id -> carimbo já atendido
  var lastShown = {};   // id -> quando disparou por último (intervalo)
  var baselineDone = false;

  var channelName = '';
  var category = '';
  var playing = false; // só mostra anúncio com o player no ar

  var pollTimer = null, tickTimer = null, hideTimer = null, exitTimer = null;

  var els = {}; // video, behind, front, box

  // -------- rede (XHR, igual api.js) --------
  function getJson(path, cb) {
    var xhr = new XMLHttpRequest();
    try { xhr.open('GET', BASE + path, true); } catch (e) { cb(null); return; }
    xhr.timeout = 12000;
    xhr.onload = function () {
      var d = null;
      try { d = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (e) { d = null; }
      cb(d);
    };
    xhr.onerror = function () { cb(null); };
    xhr.ontimeout = function () { cb(null); };
    xhr.send(null);
  }

  function nowMs() { return (new Date()).getTime(); }
  function parseTime(s) { var t = Date.parse(s || ''); return isNaN(t) ? 0 : t; }

  // -------- targeting --------
  function matches(a) {
    var v = (a.targetValue || '').toLowerCase().replace(/^\s+|\s+$/g, '');
    if (a.targetType === 'category') {
      return v !== '' && category.toLowerCase().indexOf(v) >= 0;
    }
    if (a.targetType === 'channel') {
      return v !== '' && channelName.toLowerCase().indexOf(v) >= 0;
    }
    return true;
  }

  function creativeUrl(a) {
    return (a.videoUrl && a.videoUrl !== '') ? a.videoUrl : a.imageUrl;
  }

  // -------- ciclo --------
  function refresh() {
    getJson('/api/tv/ads', function (d) {
      if (!d || !d.ads) { return; }
      ads = d.ads;
      // BASELINE: no 1º carregamento, todo "Exibir agora" que já estava no
      // servidor vira "já visto" — só um clique feito COM o app aberto dispara.
      if (!baselineDone) {
        for (var i = 0; i < ads.length; i++) {
          var t = parseTime(ads[i].showNowAt);
          if (t > 0) { seenShowNow[ads[i].id] = t; }
        }
        baselineDone = true;
      }
      maybeShow();
    });
  }

  function maybeShow() {
    if (current || !playing || ads.length === 0 || channelName === '') { return; }
    var now = nowMs();

    // 1) "Exibir agora" do painel (prioridade, janela de 2 min).
    for (var i = 0; i < ads.length; i++) {
      var a = ads[i];
      var req = parseTime(a.showNowAt);
      if (req <= 0) { continue; }
      if (!matches(a)) { continue; }
      var seen = seenShowNow[a.id] || 0;
      if (req <= seen) { continue; }
      if (now - req > 120000) { continue; } // > 2 min: não é do momento
      seenShowNow[a.id] = req;
      show(a);
      return;
    }

    // 2) Agendados por intervalo.
    for (var j = 0; j < ads.length; j++) {
      var b = ads[j];
      if (!b.everyMinutes || b.everyMinutes <= 0) { continue; }
      if (!matches(b)) { continue; }
      var last = lastShown[b.id] || 0;
      if (last === 0) { lastShown[b.id] = now; continue; } // não pula na cara ao abrir
      if (now - last < b.everyMinutes * 60000) { continue; }
      show(b);
      return;
    }
  }

  // Formatos que ficam ATRÁS do vídeo (vídeo encolhe e revela).
  var BEHIND = { split: true, squeeze: true };
  // Formatos que REDIMENSIONAM o vídeo (encolhe/aumenta). L-Shape agora fica
  // MAIOR e o "L" do anúncio vai na FRENTE cobrindo as bordas (ver .ad-lshape).
  var RESIZE = { lshape: true, split: true, squeeze: true };

  // Retângulo do VÍDEO por formato (em 1920x1080).
  function videoRect(fmt) {
    // L-Shape: vídeo grande no topo-esquerda; passa um pouco por baixo do "L".
    if (fmt === 'lshape') { return { l: 0, t: 0, w: 1632, h: 950 }; }
    if (fmt === 'split') { return { l: 0, t: 0, w: 1114, h: 1080 }; }
    if (fmt === 'squeeze') { return { l: 250, t: 97, w: 1420, h: 886 }; }
    return { l: 0, t: 0, w: 1920, h: 1080 }; // cheio (overlay/lower_third)
  }

  function applyVideoRect(r, animate) {
    var v = els.video;
    v.style.transition = animate ? 'all 1.2s cubic-bezier(0.4,0,0.2,1)' : 'none';
    v.style.left = r.l + 'px';
    v.style.top = r.t + 'px';
    v.style.width = r.w + 'px';
    v.style.height = r.h + 'px';
  }

  function buildCreative(a) {
    var url = creativeUrl(a);
    if (a.videoUrl && a.videoUrl !== '') {
      var vid = document.createElement('video');
      vid.className = 'ad-media';
      vid.src = url;
      vid.autoplay = true;
      vid.loop = true;
      vid.muted = true;          // NUNCA mexe no áudio da transmissão
      vid.setAttribute('playsinline', '');
      try { vid.play(); } catch (e) {}
      return vid;
    }
    var img = document.createElement('img');
    img.className = 'ad-media';
    img.src = url;
    return img;
  }

  function show(a) {
    current = a;
    lastShown[a.id] = nowMs();

    var fmt = a.format || 'overlay';
    // L-Shape/overlay/lower_third ficam NA FRENTE; split/squeeze ficam atrás.
    var host = BEHIND[fmt] ? els.behind : els.front;

    // posiciona a caixa do anúncio conforme o formato
    var box = els.box;
    box.className = 'ad-box ad-' + fmt;
    box.innerHTML = '';
    box.appendChild(buildCreative(a));

    if (box.parentNode !== host) { host.appendChild(box); }

    // formatos que mexem no tamanho do vídeo
    if (RESIZE[fmt]) { applyVideoRect(videoRect(fmt), true); }
    // força reflow p/ animar a opacidade/scale
    /* jshint ignore:start */
    void box.offsetWidth;
    /* jshint ignore:end */
    box.className += ' ad-visivel';

    var secs = a.durationSecs || 15;
    if (secs < 3) { secs = 3; }
    if (secs > 600) { secs = 600; }
    if (hideTimer) { clearTimeout(hideTimer); }
    hideTimer = setTimeout(hide, secs * 1000);
  }

  function hide() {
    if (!current) { return; }
    var box = els.box;
    box.className = box.className.replace(' ad-visivel', '');
    // volta o vídeo pro cheio junto com o fade de saída
    applyVideoRect(videoRect('full'), true);
    if (exitTimer) { clearTimeout(exitTimer); }
    exitTimer = setTimeout(function () {
      box.innerHTML = '';
      box.className = 'ad-box';
    }, 1200);
    current = null;
  }

  // Cancela qualquer anúncio na tela imediatamente (ex.: fechar o player).
  function clearNow() {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
    if (els.box) { els.box.innerHTML = ''; els.box.className = 'ad-box'; }
    if (els.video) { applyVideoRect(videoRect('full'), false); }
    current = null;
  }

  // -------- API pública --------
  function setPlaying(on) {
    playing = on === true;
    if (!playing) { clearNow(); }
  }

  function setContext(name, cat) {
    channelName = name || '';
    category = cat || '';
  }

  function start(refsObj) {
    els.video = refsObj.video;
    els.behind = refsObj.behind;
    els.front = refsObj.front;
    els.box = refsObj.box;
    refresh();
    if (!pollTimer) { pollTimer = setInterval(refresh, 30000); }
    if (!tickTimer) { tickTimer = setInterval(maybeShow, 5000); }
  }

  return {
    start: start,
    setContext: setContext,
    setPlaying: setPlaying,
    clearNow: clearNow,
    refresh: refresh
  };
})();
