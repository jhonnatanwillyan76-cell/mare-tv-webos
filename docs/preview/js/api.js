// ============================================================
// Maré TV — LG webOS
// js/api.js
//
// Camada de acesso à API. Usa XMLHttpRequest (não "fetch") porque
// o Chromium embarcado no webOS 3 (Chrome 38) não tem "fetch"
// nativo, e este projeto não pode usar polyfills/CDNs externos.
// As chamadas devolvem Promise (isso o Chrome 38 já suporta),
// mas todo o resto do arquivo evita recursos do ES6 em diante
// (sem arrow function, sem template literal, sem let/const,
// sem optional chaining) para rodar em qualquer TV LG antiga.
// ============================================================

var MareApi = (function () {
  'use strict';

  var BASE_URL = 'https://maretv.vercel.app';

  // Faz uma requisição HTTP genérica e devolve uma Promise que
  // resolve com { status: <número>, dados: <objeto JSON> }.
  // Só REJEITA em falha de rede/timeout/JSON inválido — respostas
  // HTTP de erro (401, 500...) resolvem normalmente, para quem
  // chamou decidir o que fazer com o "status".
  function requisitar(metodo, caminho, corpo) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();

      try {
        xhr.open(metodo, BASE_URL + caminho, true);
      } catch (erroAbertura) {
        reject(erroAbertura);
        return;
      }

      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.timeout = 15000; // 15s — evita ficar preso pra sempre numa TV com rede ruim

      xhr.onload = function () {
        var dados = null;
        try {
          dados = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch (erroJson) {
          reject(new Error('Resposta inválida do servidor'));
          return;
        }
        resolve({ status: xhr.status, dados: dados });
      };

      xhr.onerror = function () {
        reject(new Error('Falha de rede ao falar com o servidor'));
      };

      xhr.ontimeout = function () {
        reject(new Error('O servidor demorou demais para responder'));
      };

      xhr.send(corpo ? JSON.stringify(corpo) : null);
    });
  }

  // GET /api/tv/channels
  // Devolve { channels: [...], mostWatched: [...] } — o servidor já aplica a
  // arte OFICIAL da Maré nos logos e monta o trilho "Mais Assistidos" (1 por
  // emissora), igual à TV/celular.
  function buscarCanais() {
    return requisitar('GET', '/api/tv/channels', null).then(function (resp) {
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error('Não foi possível carregar a lista de canais (HTTP ' + resp.status + ')');
      }
      if (!resp.dados || !resp.dados.channels) {
        throw new Error('Resposta de canais em formato inesperado');
      }
      return {
        channels: resp.dados.channels,
        mostWatched: resp.dados.mostWatched || []
      };
    });
  }

  // POST /api/tv/login { username, password }
  // Devolve sempre um objeto { ok, active, error, status }, mesmo
  // quando o login falha (401) — quem chamou decide o que mostrar.
  function login(usuario, senha) {
    var corpo = { username: usuario, password: senha };
    return requisitar('POST', '/api/tv/login', corpo).then(function (resp) {
      var dados = resp.dados || {};
      return {
        ok: dados.ok === true,
        active: dados.active === true,
        error: dados.error || null,
        status: resp.status
      };
    });
  }

  return {
    buscarCanais: buscarCanais,
    login: login
  };
})();
