# Maré TV — App LG webOS

Cliente de TV ao vivo (IPTV) do serviço **Maré TV** para Smart TVs LG (webOS),
em HTML5/CSS/JS puro (sem framework, sem build). Exige uma **conta ativa da
Maré TV** para entrar.

## Instalar (webOS Homebrew)

Este app é publicado no **webOS Homebrew** ([webosbrew.org](https://www.webosbrew.org)).
Pelo **Homebrew Channel** na TV, procure por **Maré TV**.

Instalação manual (Developer Mode) via `ares-install` — veja `ICONS.md` e o
`appinfo.json`. O pacote `.ipk` está anexado na
[Release mais recente](https://github.com/jhonnatanwillyan76-cell/mare-tv-webos/releases/latest).

## Estrutura

- `appinfo.json` — manifesto webOS
- `index.html`, `css/`, `js/` — app (login, home, player HLS nativo)
- `icon.png` (80×80), `largeIcon.png` (130×130) — ícones
- `webosbrew/com.maretv.app.yml` — arquivo de submissão para `webosbrew/apps-repo`

## Submissão webosbrew

O `webosbrew/com.maretv.app.yml` aponta para o manifest e o `.ipk` da Release.
Metadados reais do pacote:

| campo | valor |
|---|---|
| id | `com.maretv.app` |
| version | `1.0.0` |
| type | `web` |
| sha256 | `85b3c3a34ae646cf2c5630601fe3e80c5a71143955379b23cc5e46b79081d828` |
| ipkSize | 43994 |
| installedSize | 68841 |
