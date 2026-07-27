# Ícones do app — Maré TV (LG webOS)

Este pacote **não inclui os arquivos binários dos ícones**. Antes de rodar
`ares-package`, gere e coloque manualmente os dois arquivos abaixo nesta
mesma pasta (`platforms/lg-webos/`), ao lado do `appinfo.json`:

| Arquivo         | Tamanho    | Formato | Usado em                                              |
|------------------|-----------|---------|--------------------------------------------------------|
| `icon.png`       | 80x80 px  | PNG     | Ícone pequeno (listagens, gerenciador de apps da TV)   |
| `largeIcon.png`  | 130x130 px| PNG     | Ícone grande (Launch Bar / carrossel da tela inicial)  |

## Recomendações

- Fundo **sólido**, sem transparência, usando a cor de marca escura
  `#0a0a0b` (mesma cor de `bgColor` no `appinfo.json`) — a LG Content Store
  recomenda ícones sem canal alfa para evitar bordas serrilhadas no launcher.
- Use a marca "duas ondas" em teal (`#17b3a6`) sobre o fundo escuro — o
  mesmo desenho já usado dentro do app (ver `assets/brand/mare_app_logo.png`
  na raiz do projeto Flutter) para manter a identidade visual consistente
  entre o app Android/TV e o app webOS.
- Exporte em PNG-24 (sem interlace) nos tamanhos exatos acima — o webOS não
  redimensiona os ícones automaticamente.
- Depois de gerar os PNGs, confirme que os nomes batem exatamente com os
  campos `"icon"` e `"largeIcon"` do `appinfo.json` (`icon.png` e
  `largeIcon.png`, minúsculos).

## Como gerar rapidamente

1. Abra `assets/brand/mare_app_logo.png` (raiz do projeto) em qualquer
   editor de imagem (Photoshop, GIMP, Figma, Photopea online, etc.).
2. Centralize a logo sobre um fundo `#0a0a0b` com margem de ~12% ao redor.
3. Exporte duas versões: 80x80 (`icon.png`) e 130x130 (`largeIcon.png`).
4. Salve ambas dentro de `platforms/lg-webos/`.

Sem esses dois arquivos, `ares-package` ainda consegue empacotar o app (ele
avisa, mas não bloqueia), porém a LG Content Store e o launcher da própria
TV vão exibir um ícone genérico/quebrado no lugar da marca Maré TV.
