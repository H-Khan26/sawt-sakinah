# Fonts

Self-hosted because the static-served / pywebview build runs under a CSP that forbids
CDN fetches. Every face is licensed under the SIL Open Font License, so it can be
redistributed with the app. The `@font-face` rules in `src/index.css` reference these
exact names:

| File | Source / license |
|---|---|
| `Jost-Variable.woff2` | Jost, Latin subset, variable weight (OFL, `Jost-OFL.txt`) — https://github.com/indestructible-type/Jost / Google Fonts. Committed. |
| `IbarraRealNova-Regular.woff2` | Ibarra Real Nova, variable weight 400–700 (OFL, `IbarraRealNova-OFL.txt`) — https://github.com/googlefonts/ibarrareal / Google Fonts. Committed. |
| `Amiri-Regular.woff2`, `Amiri-Bold.woff2` | Amiri, full Arabic + Latin (OFL, `Amiri-OFL.txt`) — https://github.com/aliftype/amiri / Google Fonts. Committed. |
| `IBMPlexSansArabic-Regular.woff2`, `IBMPlexSansArabic-SemiBold.woff2` | IBM Plex Sans Arabic, full Arabic + Latin (OFL, `IBMPlexSansArabic-OFL.txt`) — https://github.com/IBM/plex / Google Fonts. Committed. |

The woff2 files are unsubsetted conversions (fontTools) of the TTFs in
https://github.com/google/fonts/tree/main/ofl, except Jost. Arabic faces keep all glyphs and
OpenType layout features, which Quranic text with diacritics needs. If a file fails to load,
the fallback stacks in `tailwind.config.js` (`serif`/`sans`/`arabic-display`/`arabic`) render.
