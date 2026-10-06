# Fonts

Self-hosted because the static-served / pywebview build runs under a CSP that forbids
CDN fetches. Every face is licensed under the SIL Open Font License, so it can be
redistributed with the app. The `@font-face` rules in `src/index.css` reference these
exact names:

| File | Source / license |
|---|---|
| `Jost-Variable.woff2` | Jost, Latin subset, variable weight (OFL, `Jost-OFL.txt`) — https://github.com/indestructible-type/Jost / Google Fonts. Committed. |
| `IbarraRealNova-Regular.woff2` | Ibarra Real Nova (OFL) — https://github.com/googlefonts/ibarrareal / Google Fonts |
| `Amiri-Regular.woff2`, `Amiri-Bold.woff2` | Amiri (OFL) — https://github.com/aliftype/amiri / Google Fonts |
| `IBMPlexSansArabic-Regular.woff2`, `IBMPlexSansArabic-SemiBold.woff2` | IBM Plex Sans Arabic (OFL) — https://github.com/IBM/plex / Google Fonts |

Until a file is present the app renders the fallback stacks defined in
`tailwind.config.js` (`serif`/`sans`/`arabic-display`/`arabic`). Use `.woff2`; if you only
have `.ttf`/`.otf`, convert (e.g. `woff2_compress`) or update the `src` URLs. Ship each
font's `OFL.txt` alongside it.
