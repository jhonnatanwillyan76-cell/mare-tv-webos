// ============================================================
// Maré TV — LG webOS
// js/app.js
//
// Aplicativo inteiro (login, home, player) em um arquivo só, com
// navegação 100% por controle remoto (setas + OK + voltar).
//
// Compatibilidade: escrito para rodar em webOS 3+ (Chromium bem
// antigo, ~Chrome 38). Por isso, DE PROPÓSITO, o código evita:
//   - arrow functions          -> usa function () {}
//   - template literals        -> usa concatenação com "+"
//   - let/const                -> usa var
//   - optional chaining (?.)   -> usa "if" / checagem manual
//   - nullish coalescing (??)  -> usa "||"
//   - async/await, destructuring, spread/rest, classes
// ============================================================

(function () {
  'use strict';

  // --------------------------------------------------------
  // Constantes
  // --------------------------------------------------------

  var TECLA = {
    ESQUERDA: 37,
    CIMA: 38,
    DIREITA: 39,
    BAIXO: 40,
    OK: 13,
    VOLTAR: 461, // tecla física "Voltar" do controle remoto LG webOS
    ESC: 27      // fallback (teclado de PC, testes em navegador)
  };

  // Quantidade de colunas da grade de canais. TEM que bater com o
  // CSS (.cartao-canal + ".cartao-canal:nth-child(4n)" em
  // css/style.css) — se mudar um, muda o outro.
  var GRID_COLUNAS = 3; // réplica do ChannelBrowser da TV (3 colunas densas)

  var TEMPO_OVERLAY_MS = 4500;
  var TEMPO_LIMITE_CARREGAMENTO_MS = 15000;
  var CHAVE_LOCALSTORAGE = 'maretv_webos_credenciais';
  // Cache dos canais no aparelho: a próxima abertura mostra a grade NA HORA
  // (sem "baita loading") e revalida em segundo plano. v2 = novo formato com
  // arte oficial + mais assistidos.
  var CHAVE_CACHE_CANAIS = 'maretv_webos_canais_v2';
  // Rótulo do trilho curado (fica SEMPRE no topo, igual à TV/celular).
  var ROTULO_MAIS_ASSISTIDOS = 'Mais Assistidos';
  // Versão do app (igual ao appinfo.json/ipk) — comparada com lg_min_version
  // pra decidir a atualização OBRIGATÓRIA. BUMPE junto do ipk.
  var APP_VERSION = '1.0.2';
  var CHAVE_DEVICE = 'maretv_webos_device';
  var TEMPO_POLL_PAGAMENTO_MS = 4000;
  var TEMPO_POLL_CONFIG_MS = 60000;

  // --------------------------------------------------------
  // Estado global do app
  // --------------------------------------------------------

  var estado = {
    telaAtual: 'login', // 'login' | 'home' | 'player'
    elementoFocado: null,

    credenciais: null, // { usuario: '', senha: '' }

    canais: [],
    maisAssistidos: [],   // trilho curado (servidor) — vira a 1ª categoria
    categoriasOrdem: [],  // nomes das categorias, na ordem em que aparecem
    categoriasMapa: {},   // chaveCategoria(nome) -> array de canais
    canaisCarregados: false,

    categoriaIndice: 0,
    canalIndice: 0,
    zonaHome: 'categorias', // 'categorias' | 'canais'

    elementosCategorias: [],
    elementosCanais: [],

    player: {
      listaAtual: [],
      indiceAtual: -1,
      timerOverlay: null,
      timerCarregamento: null
    },

    config: {},           // /api/lg/config (plano/PIX + manutenção/update)
    pagamento: {          // fluxo PIX
      timer: null,
      paymentId: null,
      deviceId: null
    }
  };

  // Referências de DOM, preenchidas em inicializarReferencias()
  var refs = {};

  // --------------------------------------------------------
  // Utilitários gerais
  // --------------------------------------------------------

  // Esconde TODAS as telas e mostra a de id "tela-<nome>". Suporta:
  // login | home | player | pagamento | manutencao | update.
  function mostrarTela(nome) {
    var telas = document.getElementsByClassName('tela');
    for (var i = 0; i < telas.length; i++) {
      telas[i].classList.add('oculto');
    }
    var alvo = document.getElementById('tela-' + nome);
    if (alvo) { alvo.classList.remove('oculto'); }
    estado.telaAtual = nome;
  }

  // Aplica foco visual (classe "focado") E foco real do DOM (pra
  // TVs LG abrirem o teclado virtual sozinhas quando o elemento
  // for um <input>).
  function aplicarFoco(elemento) {
    if (!elemento) { return; }

    if (estado.elementoFocado && estado.elementoFocado !== elemento) {
      estado.elementoFocado.classList.remove('focado');
    }
    elemento.classList.add('focado');
    estado.elementoFocado = elemento;

    try {
      elemento.focus();
    } catch (erroFoco) {
      // elemento pode não aceitar foco nativo; a navegação visual
      // continua funcionando mesmo assim
    }
    try {
      elemento.scrollIntoView();
    } catch (erroScroll) {
      // ignora silenciosamente em navegadores muito antigos
    }
  }

  // Chama video.play() de um jeito seguro nas duas gerações de
  // Chromium: nas antigas (webOS 3) play() não devolve nada; nas
  // novas devolve uma Promise que pode rejeitar (ex.: autoplay
  // bloqueado). Em nenhum dos dois casos isso deve gerar erro no
  // console nem travar o app.
  function tocarVideoComSeguranca(video) {
    var resultado;
    try {
      resultado = video.play();
    } catch (erroPlaySync) {
      return;
    }
    if (resultado && typeof resultado.then === 'function') {
      resultado.then(function () {}, function () {
        // reprodução automática pode ser recusada; o usuário pode
        // tentar de novo trocando de canal ou voltando ao player
      });
    }
  }

  // Usa um prefixo fixo como chave de objeto pra nunca esbarrar em
  // propriedades "mágicas" tipo "__proto__" caso uma categoria via
  // API tenha um nome inesperado.
  function chaveCategoria(nome) {
    return 'cat_' + nome;
  }

  // --------------------------------------------------------
  // LOGIN
  // --------------------------------------------------------

  function carregarCredenciaisSalvas() {
    var bruto = null;
    try {
      bruto = localStorage.getItem(CHAVE_LOCALSTORAGE);
    } catch (erroLeitura) {
      return null;
    }
    if (!bruto) { return null; }

    try {
      var obj = JSON.parse(bruto);
      if (obj && obj.usuario && obj.senha) {
        return obj;
      }
    } catch (erroJson) {
      return null;
    }
    return null;
  }

  function salvarCredenciais(usuario, senha) {
    try {
      localStorage.setItem(CHAVE_LOCALSTORAGE, JSON.stringify({ usuario: usuario, senha: senha }));
    } catch (erroEscrita) {
      // se não der pra salvar (cota cheia, storage bloqueado...) o
      // login desta sessão continua funcionando normalmente
    }
  }

  function limparCredenciaisSalvas() {
    try {
      localStorage.removeItem(CHAVE_LOCALSTORAGE);
    } catch (erroRemocao) {}
  }

  function exibirErroLogin(mensagem) {
    refs.loginErro.textContent = mensagem;
    refs.loginErro.classList.remove('oculto');
  }

  function esconderErroLogin() {
    refs.loginErro.classList.add('oculto');
    refs.loginErro.textContent = '';
  }

  function mostrarVerificandoLogin() {
    refs.loginForm.classList.add('oculto');
    refs.loginVerificando.classList.remove('oculto');
  }

  function mostrarFormularioLogin() {
    refs.loginVerificando.classList.add('oculto');
    refs.loginForm.classList.remove('oculto');
    aplicarFoco(refs.campoUsuario);
  }

  function acionarLogin() {
    var usuario = refs.campoUsuario.value.trim();
    var senha = refs.campoSenha.value;

    if (!usuario || !senha) {
      exibirErroLogin('Preencha usuário e senha.');
      return;
    }

    esconderErroLogin();
    refs.botaoEntrar.textContent = 'Entrando…';

    MareApi.login(usuario, senha).then(function (resultado) {
      refs.botaoEntrar.textContent = 'Entrar';

      if (resultado.ok && resultado.active) {
        estado.credenciais = { usuario: usuario, senha: senha };
        salvarCredenciais(usuario, senha);
        entrarNaHome();
      } else if (resultado.ok && !resultado.active) {
        exibirErroLogin('Sua assinatura não está ativa no momento.');
      } else {
        exibirErroLogin(resultado.error || 'Usuário ou senha inválidos.');
      }
    }).catch(function (erro) {
      refs.botaoEntrar.textContent = 'Entrar';
      exibirErroLogin('Sem conexão. Verifique sua internet e tente novamente.');
      if (window.console && console.error) { console.error('Falha no login:', erro); }
    });
  }

  // No boot: se já existir credencial salva, revalida em segundo
  // plano (mostrando "Verificando sua sessão…") e entra direto na
  // Home se continuar válida; senão cai pro formulário normal.
  function iniciarLogin() {
    var credenciais = carregarCredenciaisSalvas();

    if (!credenciais) {
      mostrarFormularioLogin();
      return;
    }

    mostrarVerificandoLogin();

    MareApi.login(credenciais.usuario, credenciais.senha).then(function (resultado) {
      if (resultado.ok && resultado.active) {
        estado.credenciais = credenciais;
        entrarNaHome();
        return;
      }

      limparCredenciaisSalvas();
      mostrarFormularioLogin();
      refs.campoUsuario.value = credenciais.usuario;
      if (resultado.status === 401 || resultado.ok === false) {
        exibirErroLogin('Sessão expirada. Entre novamente.');
      } else {
        exibirErroLogin('Não foi possível verificar sua sessão agora.');
      }
    }).catch(function (erro) {
      mostrarFormularioLogin();
      refs.campoUsuario.value = credenciais.usuario;
      exibirErroLogin('Sem conexão. Verifique sua internet e tente novamente.');
      if (window.console && console.error) { console.error('Falha ao revalidar sessão:', erro); }
    });
  }

  function tratarTeclaLogin(codigo, evento) {
    var ativo = document.activeElement;
    var emCampoTexto = !!ativo && (ativo === refs.campoUsuario || ativo === refs.campoSenha);

    if (codigo === TECLA.VOLTAR) {
      evento.preventDefault();
      if (emCampoTexto) {
        ativo.blur();
      } else {
        tentarSairDoApp();
      }
      return;
    }

    if (emCampoTexto) {
      // Esquerda/Direita e digitação seguem o comportamento nativo
      // do campo (cursor de texto, teclado virtual). Só cima/baixo/OK
      // são interceptados pra navegar entre os campos.
      if (codigo === TECLA.BAIXO) {
        evento.preventDefault();
        if (ativo === refs.campoUsuario) {
          aplicarFoco(refs.campoSenha);
        } else {
          aplicarFoco(refs.botaoEntrar);
        }
      } else if (codigo === TECLA.CIMA) {
        evento.preventDefault();
        if (ativo === refs.campoSenha) {
          aplicarFoco(refs.campoUsuario);
        }
      } else if (codigo === TECLA.OK) {
        evento.preventDefault();
        if (ativo === refs.campoUsuario) {
          aplicarFoco(refs.campoSenha);
        } else {
          aplicarFoco(refs.botaoEntrar);
          acionarLogin();
        }
      }
      return;
    }

    // Foco está no botão "Entrar"
    evento.preventDefault();
    if (codigo === TECLA.CIMA) {
      aplicarFoco(refs.campoSenha);
    } else if (codigo === TECLA.OK) {
      acionarLogin();
    }
  }

  // --------------------------------------------------------
  // HOME
  // --------------------------------------------------------

  // Igual à TV: entra DIRETO no canal em tela cheia (o guia/grade abre no OK).
  function entrarNaHome() {
    if (estado.canaisCarregados) {
      renderizarCategorias();
      abrirPrimeiroCanal();
    } else {
      carregarCanais();
    }
  }

  // Abre o player no 1º canal (Mais Assistidos, quando existe) — abertura Sky.
  function abrirPrimeiroCanal() {
    mostrarTela('player');
    MareAds.setPlaying(true);
    estado.categoriaIndice = 0; // Mais Assistidos é a 1ª categoria
    var lista = canaisDaCategoriaAtual();
    if (!lista || lista.length === 0) {
      for (var i = 0; i < estado.categoriasOrdem.length; i++) {
        estado.categoriaIndice = i;
        lista = canaisDaCategoriaAtual();
        if (lista.length) { break; }
      }
    }
    if (!lista || lista.length === 0) {
      mostrarErroSemCanais('Nenhum canal disponível no momento.');
      return;
    }
    estado.player.listaAtual = lista;
    estado.player.indiceAtual = 0;
    estado.canalIndice = 0;
    definirCanalNoPlayer(lista[0]);
  }

  // Erro/vazio: mostra a tela de erro da grade POR CIMA do player.
  function mostrarErroSemCanais(msg) {
    refs.playerCarregando.classList.add('oculto');
    refs.telaHome.classList.remove('oculto');
    estado.telaAtual = 'guia';
    refs.listaCategorias.innerHTML = '';
    refs.gradeCanais.innerHTML = '';
    refs.homeVazio.classList.add('oculto');
    refs.homeErroTexto.textContent = msg;
    refs.homeErro.classList.remove('oculto');
    aplicarFoco(refs.homeErroBotao);
  }

  // ---- GUIA (a grade de canais, aberta por cima do player no OK) ----
  function abrirGuia() {
    refs.telaHome.classList.remove('oculto');
    estado.telaAtual = 'guia';
    refs.playerOverlay.classList.remove('visivel'); // esconde a info do player
    if (estado.player.timerOverlay) { clearTimeout(estado.player.timerOverlay); }
    renderizarCategorias();
    selecionarCategoria(estado.categoriaIndice || 0);
    // Abre posicionado no canal que está no ar (se estiver nesta categoria).
    var atual = estado.player.canalAtual;
    if (atual) {
      var canais = canaisDaCategoriaAtual();
      for (var i = 0; i < canais.length; i++) {
        if (canais[i].url === atual.url) { estado.canalIndice = i; break; }
      }
    }
    focoInicialHome();
  }

  function fecharGuia() {
    refs.telaHome.classList.add('oculto');
    estado.telaAtual = 'player';
    mostrarOverlayPlayer();
  }

  // Escolhe um canal no guia: sintoniza no MESMO player e fecha o guia.
  function selecionarCanalDoGuia(indice) {
    var canais = canaisDaCategoriaAtual();
    if (indice < 0 || indice >= canais.length) { return; }
    estado.player.listaAtual = canais;
    estado.player.indiceAtual = indice;
    estado.canalIndice = indice;
    var canal = canais[indice];
    fecharGuia();
    definirCanalNoPlayer(canal);
  }

  // -------- Cache no aparelho (abertura instantânea) --------
  function salvarCacheCanais(channels, mostWatched) {
    try {
      localStorage.setItem(CHAVE_CACHE_CANAIS, JSON.stringify({
        channels: channels || [],
        mostWatched: mostWatched || []
      }));
    } catch (e) {}
  }

  function carregarCacheCanais() {
    var bruto = null;
    try { bruto = localStorage.getItem(CHAVE_CACHE_CANAIS); } catch (e) { return null; }
    if (!bruto) { return null; }
    try {
      var obj = JSON.parse(bruto);
      if (obj && obj.channels && obj.channels.length) { return obj; }
    } catch (e) {}
    return null;
  }

  // Aplica os dados (canais + trilho curado) ao estado e monta as categorias
  // com "Mais Assistidos" SEMPRE no topo.
  function aplicarDados(channels, mostWatched) {
    estado.canais = normalizarCanais(channels);
    estado.maisAssistidos = normalizarCanais(mostWatched);
    var agrupado = agruparPorCategoria(estado.canais);
    var ordem = agrupado.ordem;
    var mapa = agrupado.mapa;
    if (estado.maisAssistidos.length > 0) {
      ordem.unshift(ROTULO_MAIS_ASSISTIDOS);
      mapa[chaveCategoria(ROTULO_MAIS_ASSISTIDOS)] = estado.maisAssistidos;
    }
    estado.categoriasOrdem = ordem;
    estado.categoriasMapa = mapa;
    estado.canaisCarregados = true;
    estado.categoriaIndice = 0;
  }

  function normalizarCanais(bruto) {
    var lista = [];
    if (!bruto) { return lista; }
    for (var i = 0; i < bruto.length; i++) {
      var item = bruto[i] || {};
      lista.push({
        nome: item.name || 'Sem nome',
        logo: item.logo || null,
        categoria: item.category || 'Geral',
        url: item.url || '',
        hls: item.hls || null
      });
    }
    return lista;
  }

  function agruparPorCategoria(canais) {
    var ordem = [];
    var mapa = {};
    for (var i = 0; i < canais.length; i++) {
      var canal = canais[i];
      var chave = chaveCategoria(canal.categoria);
      if (!mapa[chave]) {
        mapa[chave] = [];
        ordem.push(canal.categoria);
      }
      mapa[chave].push(canal);
    }
    return { ordem: ordem, mapa: mapa };
  }

  function carregarCanais() {
    refs.homeErro.classList.add('oculto');
    refs.homeCarregando.classList.add('oculto');
    // Abre já no player em tela cheia (igual à TV): mostra "sintonizando".
    mostrarTela('player');
    esconderErroPlayer();
    refs.playerCarregando.classList.remove('oculto');

    // 1) Cache no aparelho → abre NA HORA e revalida em segundo plano.
    var cache = carregarCacheCanais();
    if (cache) {
      aplicarDados(cache.channels, cache.mostWatched);
      renderizarCategorias();
      abrirPrimeiroCanal();
      atualizarCanaisEmSegundoPlano();
      return;
    }

    // 2) Primeira vez (sem cache): busca e abre o 1º canal.
    MareApi.buscarCanais().then(function (res) {
      aplicarDados(res.channels, res.mostWatched);
      if (estado.categoriasOrdem.length === 0) {
        mostrarErroSemCanais('Nenhum canal disponível no momento.');
        return;
      }
      salvarCacheCanais(res.channels, res.mostWatched);
      renderizarCategorias();
      abrirPrimeiroCanal();
    }).catch(function (erro) {
      mostrarErroSemCanais((erro && erro.message) || 'Não foi possível carregar os canais.');
      if (window.console && console.error) { console.error('Falha ao carregar canais:', erro); }
    });
  }

  // Revalida a lista silenciosamente e atualiza SÓ o cache — a próxima abertura
  // já pega o novo. Não re-renderiza pra não roubar o foco de quem está usando.
  function atualizarCanaisEmSegundoPlano() {
    MareApi.buscarCanais().then(function (res) {
      if (res && res.channels && res.channels.length) {
        salvarCacheCanais(res.channels, res.mostWatched);
      }
    }).catch(function () {});
  }

  // Skeleton shimmer: chips de categoria (horizontais) + linhas fantasma.
  function renderizarSkeleton() {
    var cats = refs.listaCategorias;
    cats.innerHTML = '';
    for (var c = 0; c < 6; c++) {
      var chip = document.createElement('div');
      chip.className = 'skeleton skeleton-chip';
      cats.appendChild(chip);
    }
    var grade = refs.gradeCanais;
    grade.innerHTML = '';
    refs.homeVazio.classList.add('oculto');
    for (var i = 0; i < 12; i++) {
      var card = document.createElement('div');
      card.className = 'skeleton skeleton-linha';
      grade.appendChild(card);
    }
  }

  function limparSkeleton() {
    refs.listaCategorias.innerHTML = '';
    refs.gradeCanais.innerHTML = '';
  }

  // SVG do ícone "fogo" (whatshot) da 1ª categoria "Mais Assistidos" — âmbar,
  // igual ao ChannelBrowser da TV.
  var SVG_FOGO = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5.67s.74 2.65.74 4.8c0 2.06-1.35 3.73-3.41 3.73-2.07 0-3.63-1.67-3.63-3.73l.03-.36C5.21 7.51 4 10.62 4 14c0 4.42 3.58 8 8 8s8-3.58 8-8C20 8.61 17.41 3.8 13.5.67zM11.71 19c-1.78 0-3.22-1.4-3.22-3.14 0-1.62 1.05-2.76 2.81-3.12 1.77-.36 3.6-1.21 4.62-2.58.39 1.29.59 2.65.59 4.04 0 2.65-2.15 4.8-4.8 4.8z"/></svg>';

  function focoInicialHome() {
    estado.zonaHome = 'canais';
    atualizarRelogioGuia();
    destacarCategoriaAtiva();
    centralizarChipAtivo();
    focarCanalPorIndice(estado.canalIndice || 0);
  }

  function canaisDaCategoriaAtual() {
    var nome = estado.categoriasOrdem[estado.categoriaIndice];
    if (!nome) { return []; }
    return estado.categoriasMapa[chaveCategoria(nome)] || [];
  }

  function atualizarRelogioGuia() {
    if (!refs.guiaRelogio) { return; }
    var agora = new Date();
    var hh = ('0' + agora.getHours()).slice(-2);
    var mm = ('0' + agora.getMinutes()).slice(-2);
    refs.guiaRelogio.textContent = hh + ':' + mm;
  }

  function atualizarLegendaGuia(nome) {
    if (refs.guiaCanalNome) { refs.guiaCanalNome.textContent = nome || ''; }
  }

  // Faixa horizontal de categorias (chips) — Mais Assistidos leva o ícone de fogo.
  function renderizarCategorias() {
    var container = refs.listaCategorias;
    container.innerHTML = '';
    estado.elementosCategorias = [];

    for (var i = 0; i < estado.categoriasOrdem.length; i++) {
      var nome = estado.categoriasOrdem[i];
      var chip = document.createElement('div');
      chip.className = 'guia-chip focavel';
      chip.setAttribute('tabindex', '-1');

      if (nome === ROTULO_MAIS_ASSISTIDOS) {
        var ic = document.createElement('span');
        ic.className = 'guia-chip-ic';
        ic.innerHTML = SVG_FOGO;
        chip.appendChild(ic);
      }
      var tx = document.createElement('span');
      tx.textContent = nome;
      chip.appendChild(tx);

      chip.onclick = criarTratadorCliqueCategoria(i);
      container.appendChild(chip);
      estado.elementosCategorias.push(chip);
    }
  }

  function destacarCategoriaAtiva() {
    for (var i = 0; i < estado.elementosCategorias.length; i++) {
      if (i === estado.categoriaIndice) {
        estado.elementosCategorias[i].classList.add('ativa');
      } else {
        estado.elementosCategorias[i].classList.remove('ativa');
      }
    }
  }

  // Centraliza o chip ativo na faixa (scroll horizontal manual — Chrome 38).
  function centralizarChipAtivo() {
    var c = refs.listaCategorias;
    var el = estado.elementosCategorias[estado.categoriaIndice];
    if (!c || !el) { return; }
    c.scrollLeft = el.offsetLeft - (c.clientWidth - el.offsetWidth) / 2;
  }

  function selecionarCategoria(indice) {
    if (indice < 0 || indice >= estado.categoriasOrdem.length) { return; }
    estado.categoriaIndice = indice;
    estado.canalIndice = 0;
    destacarCategoriaAtiva();
    centralizarChipAtivo();
    renderizarGradeCanais();
  }

  function criarTratadorErroLogo(linhaElemento) {
    return function () {
      this.style.display = 'none';
      linhaElemento.classList.add('sem-logo');
    };
  }

  function criarTratadorCliqueCanal(indice) {
    return function () {
      focarCanalPorIndice(indice);
      selecionarCanalDoGuia(indice);
    };
  }

  function criarTratadorCliqueCategoria(indice) {
    return function () {
      selecionarCategoria(indice);
      focarCanalPorIndice(0);
    };
  }

  // Grade de LINHAS (número + logo + nome + categoria) — réplica do ChannelBrowser.
  function renderizarGradeCanais() {
    var grade = refs.gradeCanais;
    grade.innerHTML = '';
    estado.elementosCanais = [];

    var canais = canaisDaCategoriaAtual();
    if (canais.length === 0) {
      refs.homeVazio.classList.remove('oculto');
      atualizarLegendaGuia('');
      return;
    }
    refs.homeVazio.classList.add('oculto');

    var atual = (estado.player && estado.player.canalAtual) ? estado.player.canalAtual : null;

    for (var i = 0; i < canais.length; i++) {
      var canal = canais[i];
      var linha = document.createElement('div');
      linha.className = 'guia-linha focavel';
      linha.setAttribute('tabindex', '-1');
      if (atual && atual.url === canal.url) { linha.className += ' atual'; }

      // Número (posição global do canal, em teal quando é o canal no ar).
      var num = document.createElement('div');
      num.className = 'guia-num';
      num.textContent = numeroDoCanal(canal);
      linha.appendChild(num);

      // Logo pequeno (sem placa branca) + selo com inicial de fallback.
      var lw = document.createElement('div');
      lw.className = 'guia-logo';
      if (canal.logo) {
        var img = document.createElement('img');
        img.className = 'guia-logo-img';
        img.alt = '';
        img.onerror = criarTratadorErroLogo(linha);
        img.src = canal.logo;
        lw.appendChild(img);
      } else {
        linha.classList.add('sem-logo');
      }
      var ini = document.createElement('span');
      ini.className = 'guia-logo-inicial';
      ini.textContent = (canal.nome.charAt(0) || '?').toUpperCase();
      lw.appendChild(ini);
      linha.appendChild(lw);

      // Nome + categoria (subtítulo).
      var meta = document.createElement('div');
      meta.className = 'guia-meta';
      var nm = document.createElement('div');
      nm.className = 'guia-nome';
      nm.textContent = canal.nome;
      meta.appendChild(nm);
      var sub = document.createElement('div');
      sub.className = 'guia-sub';
      sub.textContent = canal.categoria || '';
      meta.appendChild(sub);
      linha.appendChild(meta);

      linha.onclick = criarTratadorCliqueCanal(i);
      grade.appendChild(linha);
      estado.elementosCanais.push(linha);
    }
  }

  // Mantém a linha focada visível dentro da grade (scroll vertical manual).
  function garantirVisivelLinha(indice) {
    var c = refs.gradeCanais;
    var el = estado.elementosCanais[indice];
    if (!c || !el) { return; }
    var top = el.offsetTop;
    var bottom = top + el.offsetHeight;
    if (top < c.scrollTop) {
      c.scrollTop = top - 12;
    } else if (bottom > c.scrollTop + c.clientHeight) {
      c.scrollTop = bottom - c.clientHeight + 12;
    }
  }

  function focarCanalPorIndice(indice) {
    var elementos = estado.elementosCanais;
    if (elementos.length === 0) { atualizarLegendaGuia(''); return; }
    if (indice < 0) { indice = 0; }
    if (indice > elementos.length - 1) { indice = elementos.length - 1; }
    estado.canalIndice = indice;
    aplicarFoco(elementos[indice]);
    var canais = canaisDaCategoriaAtual();
    atualizarLegendaGuia(canais[indice] ? canais[indice].nome : '');
    garantirVisivelLinha(indice);
  }

  // Troca de categoria pelas PONTAS (← na 1ª coluna / → na última) — igual à TV,
  // com "wrap" circular entre categorias.
  function trocarCategoriaGuia(delta) {
    var n = estado.categoriasOrdem.length;
    if (n === 0) { return; }
    var next = (estado.categoriaIndice + delta) % n;
    if (next < 0) { next += n; }
    selecionarCategoria(next);
    focarCanalPorIndice(0);
  }

  // Navegação da guia (modelo do ChannelBrowser): índice único de canal.
  //   ↑/↓ = ±3 linhas · ←/→ = canal anterior/próximo, trocando de categoria
  //   nas pontas · OK = assistir.
  function tratarTeclaGradeCanais(codigo) {
    var total = estado.elementosCanais.length;
    var indice = estado.canalIndice;

    if (total === 0) {
      if (codigo === TECLA.ESQUERDA) { trocarCategoriaGuia(-1); }
      else if (codigo === TECLA.DIREITA) { trocarCategoriaGuia(1); }
      return;
    }

    if (codigo === TECLA.OK) {
      selecionarCanalDoGuia(indice);
    } else if (codigo === TECLA.CIMA) {
      if (indice - GRID_COLUNAS >= 0) { focarCanalPorIndice(indice - GRID_COLUNAS); }
    } else if (codigo === TECLA.BAIXO) {
      var alvo = indice + GRID_COLUNAS;
      if (alvo < total) { focarCanalPorIndice(alvo); }
      else if (indice !== total - 1) { focarCanalPorIndice(total - 1); }
    } else if (codigo === TECLA.ESQUERDA) {
      if (indice % GRID_COLUNAS === 0) { trocarCategoriaGuia(-1); }
      else { focarCanalPorIndice(indice - 1); }
    } else if (codigo === TECLA.DIREITA) {
      if (indice % GRID_COLUNAS === GRID_COLUNAS - 1 || indice >= total - 1) {
        trocarCategoriaGuia(1);
      } else {
        focarCanalPorIndice(indice + 1);
      }
    }
  }

  function tratarTeclaHome(codigo) {
    if (!refs.homeErro.classList.contains('oculto')) {
      if (codigo === TECLA.OK) {
        carregarCanais();
      } else if (codigo === TECLA.VOLTAR) {
        tentarSairDoApp();
      }
      return;
    }

    if (codigo === TECLA.VOLTAR) {
      fecharGuia(); // fecha o guia e volta pro canal em tela cheia
      return;
    }

    tratarTeclaGradeCanais(codigo);
  }

  // --------------------------------------------------------
  // PLAYER
  // --------------------------------------------------------

  function registrarEventosDoVideo() {
    var video = refs.videoPlayer;

    video.addEventListener('error', function () {
      mostrarErroPlayer();
    });

    video.addEventListener('waiting', function () {
      refs.playerCarregando.classList.remove('oculto');
    });

    var esconderCarregando = function () {
      refs.playerCarregando.classList.add('oculto');
      // o vídeo respondeu (começou a tocar/tem dados) — cancela o
      // vigia de "canal travado carregando" desta troca de canal
      if (estado.player.timerCarregamento) {
        clearTimeout(estado.player.timerCarregamento);
        estado.player.timerCarregamento = null;
      }
    };
    video.addEventListener('playing', esconderCarregando);
    video.addEventListener('canplay', esconderCarregando);
  }

  function abrirPlayer(indiceNaGrade) {
    var canais = canaisDaCategoriaAtual();
    if (indiceNaGrade < 0 || indiceNaGrade >= canais.length) { return; }

    estado.player.listaAtual = canais;
    estado.player.indiceAtual = indiceNaGrade;

    mostrarTela('player');
    MareAds.setPlaying(true); // libera anúncios enquanto está no player
    definirCanalNoPlayer(canais[indiceNaGrade]);
  }

  // hls.js só existe no AMBIENTE DE TESTE (navegador de PC), carregado pelo
  // index.html quando NÃO é webOS. Na TV real o <video> nativo toca HLS sozinho,
  // então isto fica inerte (usarHls() = false) e nada muda no app empacotado.
  var hlsInstancia = null;
  function usarHls() {
    return !window.webOS && window.Hls && window.Hls.isSupported();
  }
  function destruirHls() {
    if (hlsInstancia) {
      try { hlsInstancia.destroy(); } catch (e) {}
      hlsInstancia = null;
    }
  }

  function definirCanalNoPlayer(canal) {
    var video = refs.videoPlayer;
    var fonte = refs.videoFonte;
    var url = canal.hls || canal.url;

    estado.player.canalAtual = canal; // marca o "no ar" no guia

    esconderErroPlayer();
    refs.playerCarregando.classList.remove('oculto');
    refs.playerNomeCanal.textContent = canal.nome;
    refs.playerCategoriaCanal.textContent = canal.categoria;
    preencherPainelCanal(canal); // número + logo do painel (igual à TV)
    MareAds.setContext(canal.nome, canal.categoria); // alvo dos anúncios
    mostrarOverlayPlayer();

    try {
      video.pause();
    } catch (erroPause) {}

    destruirHls();

    if (usarHls()) {
      // Ambiente de teste (navegador): usa hls.js pra tocar o .m3u8, já que o
      // Chrome de PC não tem HLS nativo como a TV.
      fonte.src = '';
      hlsInstancia = new window.Hls({ enableWorker: true });
      hlsInstancia.loadSource(url || '');
      hlsInstancia.attachMedia(video);
      tocarVideoComSeguranca(video);
    } else {
      fonte.src = url || '';
      try {
        // necessário: só trocar o "src" do <source> não recarrega o
        // vídeo sozinho, precisa forçar com load()
        video.load();
      } catch (erroLoad) {}
      tocarVideoComSeguranca(video);
    }

    // Vigia de segurança: em certos cenários (URL inválida, servidor
    // travado, tipo de mídia não reconhecido) o <video> nunca dispara
    // nem "error" nem "playing" — fica "carregando" pra sempre. Se
    // depois de um tempo razoável ainda não engatou, trata como canal
    // indisponível em vez de deixar o usuário olhando pro spinner.
    if (estado.player.timerCarregamento) {
      clearTimeout(estado.player.timerCarregamento);
    }
    estado.player.timerCarregamento = setTimeout(function () {
      if (video.paused && video.readyState < 3) {
        mostrarErroPlayer();
      }
    }, TEMPO_LIMITE_CARREGAMENTO_MS);
  }

  function trocarCanalNoPlayer(delta) {
    var lista = estado.player.listaAtual;
    if (!lista || lista.length === 0) { return; }

    var novoIndice = estado.player.indiceAtual + delta;
    if (novoIndice < 0) { novoIndice = lista.length - 1; }
    if (novoIndice > lista.length - 1) { novoIndice = 0; }

    estado.player.indiceAtual = novoIndice;
    estado.canalIndice = novoIndice; // mantém a grade da Home sincronizada
    definirCanalNoPlayer(lista[novoIndice]);
  }

  // Número do canal (posição na lista completa) — igual ao número Sky da TV.
  function numeroDoCanal(canal) {
    for (var i = 0; i < estado.canais.length; i++) {
      if (estado.canais[i].url === canal.url) { return (i + 1); }
    }
    return '';
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function atualizarRelogioPainel() {
    if (!refs.playerClock) { return; }
    var d = new Date();
    refs.playerClock.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // Preenche número + logo do painel (o nome/categoria já são setados fora).
  function preencherPainelCanal(canal) {
    refs.playerNum.textContent = numeroDoCanal(canal);
    refs.playerLogoInicial.textContent = (canal.nome.charAt(0) || '?').toUpperCase();
    if (canal.logo) {
      refs.playerPinfo.classList.remove('sem-logo');
      refs.playerLogo.onerror = function () {
        refs.playerPinfo.classList.add('sem-logo');
      };
      refs.playerLogo.src = canal.logo;
    } else {
      refs.playerPinfo.classList.add('sem-logo');
    }
  }

  function mostrarOverlayPlayer() {
    atualizarRelogioPainel(); // relógio sempre atual quando o painel aparece
    refs.playerOverlay.classList.add('visivel');
    if (estado.player.timerOverlay) {
      clearTimeout(estado.player.timerOverlay);
    }
    estado.player.timerOverlay = setTimeout(function () {
      refs.playerOverlay.classList.remove('visivel');
    }, TEMPO_OVERLAY_MS);
  }

  function esconderErroPlayer() {
    refs.playerErro.classList.add('oculto');
  }

  function mostrarErroPlayer() {
    refs.playerCarregando.classList.add('oculto');
    refs.playerErro.classList.remove('oculto');
    refs.playerOverlay.classList.remove('visivel');
    if (estado.player.timerOverlay) {
      clearTimeout(estado.player.timerOverlay);
      estado.player.timerOverlay = null;
    }
    if (estado.player.timerCarregamento) {
      clearTimeout(estado.player.timerCarregamento);
      estado.player.timerCarregamento = null;
    }
  }

  function fecharPlayer() {
    var video = refs.videoPlayer;
    MareAds.setPlaying(false); // tira anúncio da tela e volta o vídeo pro cheio
    try {
      video.pause();
    } catch (erroPause) {}
    destruirHls();
    refs.videoFonte.src = '';
    try {
      video.load();
    } catch (erroLoad) {}

    if (estado.player.timerOverlay) {
      clearTimeout(estado.player.timerOverlay);
      estado.player.timerOverlay = null;
    }
    if (estado.player.timerCarregamento) {
      clearTimeout(estado.player.timerCarregamento);
      estado.player.timerCarregamento = null;
    }

    mostrarTela('home');
    estado.zonaHome = 'canais';
    focarCanalPorIndice(estado.canalIndice);
  }

  // Player em tela cheia (estilo Sky, igual à TV):
  //  ↑↓/←→ zapeia · OK: mostra a info; 2º OK abre o GUIA · VOLTAR: sai do app.
  function tratarTeclaPlayer(codigo) {
    if (codigo === TECLA.VOLTAR) {
      tentarSairDoApp();
      return;
    }

    var erroVisivel = !refs.playerErro.classList.contains('oculto');

    if (codigo === TECLA.CIMA || codigo === TECLA.ESQUERDA) {
      trocarCanalNoPlayer(-1);
    } else if (codigo === TECLA.BAIXO || codigo === TECLA.DIREITA) {
      trocarCanalNoPlayer(1);
    } else if (codigo === TECLA.OK) {
      // Canal ruim OU info já à vista → abre o guia; senão, traz a info.
      if (erroVisivel || refs.playerOverlay.classList.contains('visivel')) {
        abrirGuia();
      } else {
        mostrarOverlayPlayer();
      }
    }
  }

  // --------------------------------------------------------
  // Navegação por controle remoto (dispatcher global)
  // --------------------------------------------------------

  function tentarSairDoApp() {
    // Fecha o app no padrão webOS ao pressionar "Voltar" na tela
    // raiz. Fora da TV (navegador comum) "window.webOS" não existe
    // — nesse caso simplesmente não faz nada, pra não atrapalhar
    // testes no PC.
    if (window.webOS && typeof window.webOS.platformBack === 'function') {
      window.webOS.platformBack();
    }
  }

  function aoPressionarTecla(evento) {
    var codigo = evento.keyCode || evento.which;
    if (codigo === TECLA.ESC) {
      codigo = TECLA.VOLTAR;
    }

    var teclasControladas = [
      TECLA.ESQUERDA, TECLA.CIMA, TECLA.DIREITA, TECLA.BAIXO,
      TECLA.OK, TECLA.VOLTAR
    ];
    if (teclasControladas.indexOf(codigo) === -1) {
      return;
    }

    if (estado.telaAtual === 'login') {
      tratarTeclaLogin(codigo, evento);
    } else if (estado.telaAtual === 'pagamento') {
      tratarTeclaPagamento(codigo, evento);
    } else if (estado.telaAtual === 'manutencao' || estado.telaAtual === 'update') {
      tratarTeclaBloqueio(codigo, evento);
    } else if (estado.telaAtual === 'guia' || estado.telaAtual === 'home') {
      evento.preventDefault();
      tratarTeclaHome(codigo);
    } else if (estado.telaAtual === 'player') {
      evento.preventDefault();
      tratarTeclaPlayer(codigo);
    }
  }

  // Pausa o vídeo quando o app fica oculto (ex.: usuário abre o
  // menu do webOS ou troca de app) e retoma quando volta a ficar
  // visível, se ainda estiver na tela do player.
  function registrarVisibilidadeWebOS() {
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (estado.telaAtual === 'player') {
          try { refs.videoPlayer.pause(); } catch (erroPause) {}
        }
      } else if (estado.telaAtual === 'player') {
        if (refs.playerErro.classList.contains('oculto')) {
          tocarVideoComSeguranca(refs.videoPlayer);
        }
      }
    });
  }

  // --------------------------------------------------------
  // CONFIG REMOTA + GATES (manutenção / atualização obrigatória)
  // --------------------------------------------------------
  function versaoParaNumeros(v) {
    var partes = ('' + (v || '')).split('.');
    var nums = [];
    for (var i = 0; i < partes.length; i++) {
      var n = parseInt(partes[i], 10);
      nums.push(isNaN(n) ? 0 : n);
    }
    return nums;
  }
  // true se a < b (versão instalada menor que a exigida)
  function versaoMenor(a, b) {
    var na = versaoParaNumeros(a), nb = versaoParaNumeros(b);
    var len = Math.max(na.length, nb.length);
    for (var i = 0; i < len; i++) {
      var x = na[i] || 0, y = nb[i] || 0;
      if (x < y) { return true; }
      if (x > y) { return false; }
    }
    return false;
  }
  function updateObrigatorio(c) {
    if (!c) { return false; }
    if (c.minVersion && versaoMenor(APP_VERSION, c.minVersion)) { return true; }
    if (c.updateMandatory && c.latestVersion && versaoMenor(APP_VERSION, c.latestVersion)) { return true; }
    return false;
  }
  function formatarReais(cents) {
    var v = (Number(cents) || 0) / 100;
    return 'R$ ' + v.toFixed(2).replace('.', ',');
  }

  function carregarConfig(aoTerminar) {
    MareApi.buscarConfig().then(function (cfg) {
      estado.config = cfg || {};
      atualizarTextoPlano();
      if (aoTerminar) { aoTerminar(); }
    }).catch(function () {
      estado.config = estado.config || {};
      if (aoTerminar) { aoTerminar(); }
    });
  }

  function atualizarTextoPlano() {
    var c = estado.config || {};
    if (!refs.pagamentoPlano) { return; }
    if (c.priceCents) {
      var nome = c.planName || 'Plano';
      var dias = c.planDays ? (' · ' + c.planDays + ' dias') : '';
      refs.pagamentoPlano.textContent = nome + ' — ' + formatarReais(c.priceCents) + dias;
    }
  }

  // Decide se uma tela de bloqueio deve aparecer. Retorna true se bloqueou.
  function aplicarGates() {
    var c = estado.config || {};
    if (c.maintenance === true) {
      refs.manutencaoMsg.textContent = c.maintenanceMessage ||
        'Estamos melhorando a Maré TV. Voltamos já!';
      mostrarTela('manutencao');
      aplicarFoco(refs.botaoManutencaoRetry);
      return true;
    }
    if (updateObrigatorio(c)) {
      refs.updateMsg.textContent = c.updateMessage ||
        'Saiu uma versão nova da Maré TV. Atualize para continuar assistindo.';
      if (c.storeUrl) {
        refs.updateStore.textContent = c.storeUrl;
        refs.updateStore.classList.remove('oculto');
      } else {
        refs.updateStore.classList.add('oculto');
      }
      mostrarTela('update');
      aplicarFoco(refs.botaoUpdateRetry);
      return true;
    }
    return false;
  }

  // Poll periódico: reflete manutenção/atualização mesmo com o app aberto, e
  // libera sozinho quando o admin desliga.
  function pollConfig() {
    MareApi.buscarConfig().then(function (cfg) {
      estado.config = cfg || {};
      atualizarTextoPlano();
      var bloqueado = (estado.telaAtual === 'manutencao' || estado.telaAtual === 'update');
      if (aplicarGates()) { return; }
      if (bloqueado) {
        if (estado.credenciais) { entrarNaHome(); } else { iniciarLogin(); }
      }
    }).catch(function () {});
  }

  function reverificarGate() {
    MareApi.buscarConfig().then(function (cfg) {
      estado.config = cfg || {};
      if (aplicarGates()) { return; }
      if (estado.credenciais) { entrarNaHome(); } else { iniciarLogin(); }
    }).catch(function () {});
  }

  function tratarTeclaBloqueio(codigo, evento) {
    evento.preventDefault();
    if (codigo === TECLA.OK) {
      reverificarGate();
    } else if (codigo === TECLA.VOLTAR) {
      tentarSairDoApp();
    }
  }

  // --------------------------------------------------------
  // PAGAMENTO (assinar via PIX)
  // --------------------------------------------------------
  function obterDeviceId() {
    var id = null;
    try { id = localStorage.getItem(CHAVE_DEVICE); } catch (e) {}
    if (!id) {
      id = 'lg-' + Math.floor((1 + Math.random()) * 1e12).toString(16) + '-' + (new Date()).getTime();
      try { localStorage.setItem(CHAVE_DEVICE, id); } catch (e) {}
    }
    return id;
  }

  function abrirPagamento() {
    pararPollPagamento();
    mostrarTela('pagamento');
    refs.pagamentoForm.classList.remove('oculto');
    refs.pagamentoQr.classList.add('oculto');
    refs.pagamentoErro.classList.add('oculto');
    atualizarTextoPlano();

    var c = estado.config || {};
    if (!c.pixEnabled) {
      exibirErroPagamento('Pagamento indisponível no momento. Assine pelo site e entre com usuário e senha.');
    }
    aplicarFoco(refs.pagCpf);
  }

  function exibirErroPagamento(msg) {
    refs.pagamentoErro.textContent = msg;
    refs.pagamentoErro.classList.remove('oculto');
  }

  function mensagemErroPix(code) {
    if (code === 'cpf_obrigatorio') { return 'CPF obrigatório para gerar o PIX.'; }
    if (code === 'pix_indisponivel') { return 'PIX indisponível agora. Assine pelo site.'; }
    return 'Não foi possível gerar o PIX. Tente novamente.';
  }

  function gerarPix() {
    var cpf = (refs.pagCpf.value || '').replace(/\D/g, '');
    if (cpf.length !== 11) {
      exibirErroPagamento('Digite um CPF válido (11 números).');
      aplicarFoco(refs.pagCpf);
      return;
    }
    refs.pagamentoErro.classList.add('oculto');
    var rotuloBotao = refs.botaoGerarPix.getElementsByTagName('span')[0];
    if (rotuloBotao) { rotuloBotao.textContent = 'Gerando…'; }

    var deviceId = obterDeviceId();
    MareApi.iniciarPix(deviceId, '', cpf).then(function (res) {
      if (rotuloBotao) { rotuloBotao.textContent = 'Gerar QR Code PIX'; }
      var d = res.dados || {};
      if (res.status >= 200 && res.status < 300 && d.qrCodeBase64) {
        mostrarQrPix(d, deviceId);
      } else {
        exibirErroPagamento(mensagemErroPix(d.error));
      }
    }).catch(function () {
      if (rotuloBotao) { rotuloBotao.textContent = 'Gerar QR Code PIX'; }
      exibirErroPagamento('Sem conexão. Tente novamente.');
    });
  }

  function mostrarQrPix(d, deviceId) {
    refs.pagamentoForm.classList.add('oculto');
    refs.pagamentoQr.classList.remove('oculto');
    // "plano · preço" em teal (igual à TV): planName · priceLabel
    var c = estado.config || {};
    var plano = c.planName || 'Assinatura';
    var preco = d.amountCents ? formatarReais(d.amountCents)
      : (c.priceCents ? formatarReais(c.priceCents) : '');
    refs.pagamentoValor.textContent = preco ? (plano + ' · ' + preco) : plano;
    refs.pagamentoQrImg.src = 'data:image/png;base64,' + d.qrCodeBase64;
    refs.pagamentoStatusTexto.textContent = 'Aguardando o pagamento…';
    aplicarFoco(refs.botaoCancelarPix);
    iniciarPollPagamento(d.paymentId, deviceId);
  }

  function iniciarPollPagamento(paymentId, deviceId) {
    pararPollPagamento();
    estado.pagamento.paymentId = paymentId;
    estado.pagamento.deviceId = deviceId;
    estado.pagamento.timer = setInterval(function () {
      MareApi.statusPix(paymentId, deviceId).then(function (s) {
        if (s && s.paid === true && s.username && s.password) {
          sucessoPagamento(s.username, s.password);
        } else if (s && s.status && s.status !== 'pending' && s.status !== 'approved') {
          pararPollPagamento();
          refs.pagamentoStatusTexto.textContent = 'Pagamento não concluído. Gere um novo PIX.';
        }
      }).catch(function () {});
    }, TEMPO_POLL_PAGAMENTO_MS);
  }

  function pararPollPagamento() {
    if (estado.pagamento.timer) {
      clearInterval(estado.pagamento.timer);
      estado.pagamento.timer = null;
    }
  }

  function sucessoPagamento(usuario, senha) {
    pararPollPagamento();
    estado.credenciais = { usuario: usuario, senha: senha };
    salvarCredenciais(usuario, senha);
    entrarNaHome();
  }

  function fecharPagamento() {
    pararPollPagamento();
    iniciarLogin();
  }

  function indiceDe(lista, el) {
    for (var i = 0; i < lista.length; i++) { if (lista[i] === el) { return i; } }
    return -1;
  }

  function pagFocaveis() {
    if (!refs.pagamentoQr.classList.contains('oculto')) {
      return [refs.botaoCancelarPix];
    }
    var lista = [refs.pagCpf, refs.botaoGerarPix, refs.botaoVoltarLogin];
    return lista;
  }

  function tratarTeclaPagamento(codigo, evento) {
    var ativo = document.activeElement;
    var emCampo = (ativo === refs.pagCpf);

    if (codigo === TECLA.VOLTAR) {
      evento.preventDefault();
      if (emCampo) { ativo.blur(); return; }
      fecharPagamento();
      return;
    }

    var lista = pagFocaveis();
    var idx = indiceDe(lista, estado.elementoFocado);
    if (idx < 0) { idx = 0; }

    if (codigo === TECLA.BAIXO) {
      evento.preventDefault();
      if (idx < lista.length - 1) { aplicarFoco(lista[idx + 1]); }
    } else if (codigo === TECLA.CIMA) {
      evento.preventDefault();
      if (idx > 0) { aplicarFoco(lista[idx - 1]); }
    } else if (codigo === TECLA.OK) {
      evento.preventDefault();
      var el = lista[idx];
      if (el === refs.pagCpf) {
        aplicarFoco(refs.botaoGerarPix);
      } else if (el && typeof el.click === 'function') {
        el.click();
      }
    }
  }

  // --------------------------------------------------------
  // Inicialização
  // --------------------------------------------------------

  function inicializarReferencias() {
    refs.telaLogin = document.getElementById('tela-login');
    refs.telaHome = document.getElementById('tela-home');
    refs.telaPlayer = document.getElementById('tela-player');

    refs.loginVerificando = document.getElementById('login-verificando');
    refs.loginForm = document.getElementById('login-form');
    refs.campoUsuario = document.getElementById('campo-usuario');
    refs.campoSenha = document.getElementById('campo-senha');
    refs.loginErro = document.getElementById('login-erro');
    refs.botaoEntrar = document.getElementById('botao-entrar');

    refs.listaCategorias = document.getElementById('lista-categorias');
    refs.gradeCanais = document.getElementById('grade-canais');
    refs.guiaRelogio = document.getElementById('guia-relogio');
    refs.guiaCanalNome = document.getElementById('guia-canal-nome');
    refs.homeVazio = document.getElementById('home-vazio');
    refs.homeCarregando = document.getElementById('home-carregando');
    refs.homeErro = document.getElementById('home-erro');
    refs.homeErroTexto = document.getElementById('home-erro-texto');
    refs.homeErroBotao = document.getElementById('home-erro-botao');

    refs.videoPlayer = document.getElementById('video-player');
    refs.videoFonte = document.getElementById('video-fonte');
    refs.playerCarregando = document.getElementById('player-carregando');
    refs.playerOverlay = document.getElementById('player-overlay');
    refs.playerNomeCanal = document.getElementById('player-nome-canal');
    refs.playerCategoriaCanal = document.getElementById('player-categoria-canal');
    refs.playerNum = document.getElementById('player-num');
    refs.playerLogo = document.getElementById('player-logo');
    refs.playerLogoInicial = document.getElementById('player-logo-inicial');
    refs.playerClock = document.getElementById('player-clock');
    refs.playerPinfo = refs.playerOverlay.getElementsByClassName('pinfo')[0];
    refs.playerErro = document.getElementById('player-erro');

    // Pagamento (PIX)
    refs.pagamentoPlano = document.getElementById('pagamento-plano');
    refs.pagamentoForm = document.getElementById('pagamento-form');
    refs.pagCpf = document.getElementById('pag-cpf');
    refs.pagamentoErro = document.getElementById('pagamento-erro');
    refs.botaoGerarPix = document.getElementById('botao-gerar-pix');
    refs.botaoVoltarLogin = document.getElementById('botao-voltar-login');
    refs.pagamentoQr = document.getElementById('pagamento-qr');
    refs.pagamentoValor = document.getElementById('pagamento-valor');
    refs.pagamentoQrImg = document.getElementById('pagamento-qr-img');
    refs.pagamentoStatusTexto = document.getElementById('pagamento-status-texto');
    refs.botaoCancelarPix = document.getElementById('botao-cancelar-pix');
    refs.botaoAssinar = document.getElementById('botao-assinar');

    // Bloqueio (manutenção / atualização)
    refs.manutencaoMsg = document.getElementById('manutencao-msg');
    refs.botaoManutencaoRetry = document.getElementById('botao-manutencao-retry');
    refs.updateMsg = document.getElementById('update-msg');
    refs.updateStore = document.getElementById('update-store');
    refs.botaoUpdateRetry = document.getElementById('botao-update-retry');

    // Camadas de anúncio
    refs.adBehind = document.getElementById('ad-behind');
    refs.adFront = document.getElementById('ad-front');
    refs.adBox = document.getElementById('ad-box');

    refs.botaoEntrar.onclick = acionarLogin;
    refs.homeErroBotao.onclick = carregarCanais;
    refs.botaoAssinar.onclick = abrirPagamento;
    refs.botaoGerarPix.onclick = gerarPix;
    refs.botaoVoltarLogin.onclick = fecharPagamento;
    refs.botaoCancelarPix.onclick = fecharPagamento;
    refs.botaoManutencaoRetry.onclick = reverificarGate;
    refs.botaoUpdateRetry.onclick = reverificarGate;

    registrarEventosDoVideo();
  }

  function iniciarApp() {
    inicializarReferencias();
    document.addEventListener('keydown', aoPressionarTecla);
    registrarVisibilidadeWebOS();

    // Anúncios dentro da transmissão (mesma /api/tv/ads da TV/celular).
    MareAds.start({
      video: refs.videoPlayer,
      behind: refs.adBehind,
      front: refs.adFront,
      box: refs.adBox
    });

    // Config remota da LG (plano/PIX + manutenção/atualização). Se um gate
    // estiver ligado, bloqueia ANTES do login; senão segue o fluxo normal.
    carregarConfig(function () {
      if (aplicarGates()) { return; }
      iniciarLogin();
    });
    if (!estado.configTimer) {
      estado.configTimer = setInterval(pollConfig, TEMPO_POLL_CONFIG_MS);
    }
  }

  // AMBIENTE DE TESTE (só no navegador, NUNCA na TV): injeta canais fake e abre
  // o fluxo igual à TV (player + guia) sem precisar logar. Inerte no webOS.
  if (!window.webOS) {
    window.__mare = {
      fake: function (channels, mw) {
        inicializarReferencias();
        aplicarDados(channels, mw || []);
        renderizarCategorias();
        abrirPrimeiroCanal();
      },
      guia: function () { abrirGuia(); },
      fecharGuia: function () { fecharGuia(); }
    };
  }

  document.addEventListener('DOMContentLoaded', iniciarApp);
})();
