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
  var GRID_COLUNAS = 4;

  var TEMPO_OVERLAY_MS = 3000;
  var TEMPO_LIMITE_CARREGAMENTO_MS = 15000;
  var CHAVE_LOCALSTORAGE = 'maretv_webos_credenciais';
  // Cache dos canais no aparelho: a próxima abertura mostra a grade NA HORA
  // (sem "baita loading") e revalida em segundo plano. v2 = novo formato com
  // arte oficial + mais assistidos.
  var CHAVE_CACHE_CANAIS = 'maretv_webos_canais_v2';
  // Rótulo do trilho curado (fica SEMPRE no topo, igual à TV/celular).
  var ROTULO_MAIS_ASSISTIDOS = 'Mais Assistidos';

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
    }
  };

  // Referências de DOM, preenchidas em inicializarReferencias()
  var refs = {};

  // --------------------------------------------------------
  // Utilitários gerais
  // --------------------------------------------------------

  function mostrarTela(nome) {
    refs.telaLogin.classList.add('oculto');
    refs.telaHome.classList.add('oculto');
    refs.telaPlayer.classList.add('oculto');

    if (nome === 'login') {
      refs.telaLogin.classList.remove('oculto');
    } else if (nome === 'home') {
      refs.telaHome.classList.remove('oculto');
    } else if (nome === 'player') {
      refs.telaPlayer.classList.remove('oculto');
    }

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

  function entrarNaHome() {
    mostrarTela('home');
    if (estado.canaisCarregados) {
      renderizarCategorias();
      selecionarCategoria(estado.categoriaIndice);
      focoInicialHome();
    } else {
      carregarCanais();
    }
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

    // 1) Se há cache no aparelho, a grade aparece NA HORA (sem loading) e a
    //    lista é revalidada em segundo plano.
    var cache = carregarCacheCanais();
    if (cache) {
      aplicarDados(cache.channels, cache.mostWatched);
      renderizarCategorias();
      selecionarCategoria(0);
      focoInicialHome();
      atualizarCanaisEmSegundoPlano();
      return;
    }

    // 2) Primeira vez (sem cache): skeleton shimmer enquanto busca — sem spinner
    //    "pelado". Com o cache do servidor quente, a resposta é rápida.
    renderizarSkeleton();

    MareApi.buscarCanais().then(function (res) {
      aplicarDados(res.channels, res.mostWatched);

      if (estado.categoriasOrdem.length === 0) {
        limparSkeleton();
        refs.homeErroTexto.textContent = 'Nenhum canal disponível no momento.';
        refs.homeErro.classList.remove('oculto');
        aplicarFoco(refs.homeErroBotao);
        return;
      }

      salvarCacheCanais(res.channels, res.mostWatched);
      renderizarCategorias();
      selecionarCategoria(0);
      focoInicialHome();
    }).catch(function (erro) {
      limparSkeleton();
      refs.homeErroTexto.textContent = (erro && erro.message) || 'Não foi possível carregar os canais.';
      refs.homeErro.classList.remove('oculto');
      aplicarFoco(refs.homeErroBotao);
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

  // Skeleton shimmer: chips de categoria + cards fantasma enquanto carrega.
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
      card.className = 'skeleton skeleton-card';
      grade.appendChild(card);
    }
  }

  function limparSkeleton() {
    refs.listaCategorias.innerHTML = '';
    refs.gradeCanais.innerHTML = '';
  }

  function focoInicialHome() {
    estado.zonaHome = 'categorias';
    focarCategoriaPorIndice(estado.categoriaIndice || 0);
  }

  function canaisDaCategoriaAtual() {
    var nome = estado.categoriasOrdem[estado.categoriaIndice];
    if (!nome) { return []; }
    return estado.categoriasMapa[chaveCategoria(nome)] || [];
  }

  function renderizarCategorias() {
    var container = refs.listaCategorias;
    container.innerHTML = '';
    estado.elementosCategorias = [];

    for (var i = 0; i < estado.categoriasOrdem.length; i++) {
      var item = document.createElement('div');
      item.className = 'item-categoria focavel';
      item.setAttribute('tabindex', '-1');
      item.textContent = estado.categoriasOrdem[i];
      item.onclick = criarTratadorCliqueCategoria(i);

      container.appendChild(item);
      estado.elementosCategorias.push(item);
    }
  }

  function selecionarCategoria(indice) {
    if (indice < 0 || indice >= estado.categoriasOrdem.length) { return; }

    estado.categoriaIndice = indice;
    estado.canalIndice = 0;

    for (var i = 0; i < estado.elementosCategorias.length; i++) {
      if (i === indice) {
        estado.elementosCategorias[i].classList.add('selecionada');
      } else {
        estado.elementosCategorias[i].classList.remove('selecionada');
      }
    }

    renderizarGradeCanais();
  }

  function criarTratadorErroLogo(cartaoElemento) {
    return function () {
      this.style.display = 'none';
      // data-inicial já foi setado no card; só marca o estado "sem logo" pra
      // aparecer o selo com a letra da emissora.
      cartaoElemento.classList.add('sem-logo');
    };
  }

  function criarTratadorCliqueCanal(indice) {
    return function () {
      focarCanalPorIndice(indice);
      abrirPlayer(indice);
    };
  }

  function criarTratadorCliqueCategoria(indice) {
    return function () {
      estado.zonaHome = 'categorias';
      selecionarCategoria(indice);
      focarCategoriaPorIndice(indice);
    };
  }

  function renderizarGradeCanais() {
    var grade = refs.gradeCanais;
    grade.innerHTML = '';
    estado.elementosCanais = [];

    var canais = canaisDaCategoriaAtual();

    if (canais.length === 0) {
      refs.homeVazio.classList.remove('oculto');
      return;
    }
    refs.homeVazio.classList.add('oculto');

    for (var i = 0; i < canais.length; i++) {
      var canal = canais[i];
      var cartao = document.createElement('div');
      cartao.className = 'cartao-canal focavel';
      cartao.setAttribute('tabindex', '-1');

      // Área da ARTE (pôster/logo oficial vindo do servidor). Ocupa o topo do
      // card, com a marca ao fundo — se a arte falhar, cai no selo com inicial.
      var arte = document.createElement('div');
      arte.className = 'cartao-canal-arte';

      var inicial = document.createElement('span');
      inicial.className = 'cartao-canal-inicial';
      inicial.textContent = (canal.nome.charAt(0) || '?').toUpperCase();
      arte.appendChild(inicial);

      if (canal.logo) {
        var img = document.createElement('img');
        img.className = 'cartao-canal-logo';
        img.alt = '';
        img.onerror = criarTratadorErroLogo(cartao);
        img.src = canal.logo;
        arte.appendChild(img);
      } else {
        cartao.classList.add('sem-logo');
      }
      cartao.appendChild(arte);

      var info = document.createElement('div');
      info.className = 'cartao-canal-info';
      var nomeSpan = document.createElement('span');
      nomeSpan.className = 'cartao-canal-nome';
      nomeSpan.textContent = canal.nome;
      info.appendChild(nomeSpan);
      cartao.appendChild(info);

      cartao.onclick = criarTratadorCliqueCanal(i);

      grade.appendChild(cartao);
      estado.elementosCanais.push(cartao);
    }
  }

  function focarCategoriaPorIndice(indice) {
    var elementos = estado.elementosCategorias;
    if (indice < 0 || indice > elementos.length - 1) { return; }
    estado.categoriaIndice = indice;
    aplicarFoco(elementos[indice]);
  }

  function focarCanalPorIndice(indice) {
    var elementos = estado.elementosCanais;
    if (elementos.length === 0) { return; }
    if (indice < 0) { indice = 0; }
    if (indice > elementos.length - 1) { indice = elementos.length - 1; }
    estado.canalIndice = indice;
    aplicarFoco(elementos[indice]);
  }

  function tratarTeclaCategorias(codigo) {
    var total = estado.categoriasOrdem.length;
    if (total === 0) { return; }

    if (codigo === TECLA.CIMA) {
      var anterior = estado.categoriaIndice - 1;
      if (anterior < 0) { return; }
      selecionarCategoria(anterior);
      focarCategoriaPorIndice(anterior);
    } else if (codigo === TECLA.BAIXO) {
      var proximo = estado.categoriaIndice + 1;
      if (proximo > total - 1) { return; }
      selecionarCategoria(proximo);
      focarCategoriaPorIndice(proximo);
    } else if (codigo === TECLA.DIREITA || codigo === TECLA.OK) {
      if (estado.elementosCanais.length > 0) {
        estado.zonaHome = 'canais';
        // Retoma no último canal focado dentro desta categoria (em vez
        // de sempre voltar pro índice 0) — focarCanalPorIndice() já
        // limita o índice aos limites da grade atual.
        focarCanalPorIndice(estado.canalIndice);
      }
    }
  }

  function tratarTeclaGradeCanais(codigo) {
    var total = estado.elementosCanais.length;
    if (total === 0) { return; }
    var indice = estado.canalIndice;

    if (codigo === TECLA.OK) {
      abrirPlayer(indice);
      return;
    }

    if (codigo === TECLA.ESQUERDA) {
      if (indice % GRID_COLUNAS === 0) {
        estado.zonaHome = 'categorias';
        focarCategoriaPorIndice(estado.categoriaIndice);
      } else {
        focarCanalPorIndice(indice - 1);
      }
    } else if (codigo === TECLA.DIREITA) {
      var ultimaColuna = (indice % GRID_COLUNAS === GRID_COLUNAS - 1);
      if (!ultimaColuna && indice + 1 < total) {
        focarCanalPorIndice(indice + 1);
      }
    } else if (codigo === TECLA.CIMA) {
      if (indice - GRID_COLUNAS >= 0) {
        focarCanalPorIndice(indice - GRID_COLUNAS);
      } else {
        estado.zonaHome = 'categorias';
        focarCategoriaPorIndice(estado.categoriaIndice);
      }
    } else if (codigo === TECLA.BAIXO) {
      var alvo = indice + GRID_COLUNAS;
      if (alvo < total) {
        focarCanalPorIndice(alvo);
      } else if (indice !== total - 1) {
        focarCanalPorIndice(total - 1);
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
      if (estado.zonaHome === 'canais') {
        estado.zonaHome = 'categorias';
        focarCategoriaPorIndice(estado.categoriaIndice);
      } else {
        tentarSairDoApp();
      }
      return;
    }

    if (estado.zonaHome === 'categorias') {
      tratarTeclaCategorias(codigo);
    } else {
      tratarTeclaGradeCanais(codigo);
    }
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

    esconderErroPlayer();
    refs.playerCarregando.classList.remove('oculto');
    refs.playerNomeCanal.textContent = canal.nome;
    refs.playerCategoriaCanal.textContent = canal.categoria;
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

  function mostrarOverlayPlayer() {
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

  function tratarTeclaPlayer(codigo) {
    if (codigo === TECLA.VOLTAR) {
      fecharPlayer();
      return;
    }

    var erroVisivel = !refs.playerErro.classList.contains('oculto');

    if (codigo === TECLA.CIMA) {
      trocarCanalNoPlayer(-1);
    } else if (codigo === TECLA.BAIXO) {
      trocarCanalNoPlayer(1);
    } else if (codigo === TECLA.OK) {
      if (!erroVisivel) {
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
    } else if (estado.telaAtual === 'home') {
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
    refs.playerErro = document.getElementById('player-erro');

    refs.botaoEntrar.onclick = acionarLogin;
    refs.homeErroBotao.onclick = carregarCanais;

    registrarEventosDoVideo();
  }

  function iniciarApp() {
    inicializarReferencias();
    document.addEventListener('keydown', aoPressionarTecla);
    registrarVisibilidadeWebOS();
    iniciarLogin();
  }

  document.addEventListener('DOMContentLoaded', iniciarApp);
})();
