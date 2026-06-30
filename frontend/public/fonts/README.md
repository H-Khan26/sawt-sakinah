# Fonts

Self-hosted because the static-served / pywebview build runs under a CSP that forbids
CDN fetches. Drop the following `.woff2` files here (the `@font-face` rules in
`src/index.css` reference these exact names):

| File | Source / license |
|---|---|
| `IbarraRealNova-Regular.woff2` | Ibarra Real Nova (OFL) — copy from the base theme's assets, or Google Fonts |
| `Futura-Regular.woff2` | Futura — copy from the base theme's licensed assets |
| `Amiri-Regular.woff2`, `Amiri-Bold.woff2` | Amiri (OFL) — https://github.com/aliftype/amiri / Google Fonts |
| `IBMPlexSansArabic-Regular.woff2`, `IBMPlexSansArabic-SemiBold.woff2` | IBM Plex Sans Arabic (OFL) — https://github.com/IBM/plex / Google Fonts |

Until the files are present the app renders the fallback stacks defined in
`tailwind.config.js` (`serif`/`sans`/`arabic-display`/`arabic`). Use `.woff2`; if you only
have `.ttf`/`.otf`, convert (e.g. `woff2_compress`) or update the `src` URLs.
