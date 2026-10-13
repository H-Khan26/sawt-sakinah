/**
 * A colour bound to a token in src/theme/tokens.css. Opacity modifiers (`bg-accent/10`) mix the
 * token with transparent, since a `var()` colour has no channels Tailwind can split.
 */
function token(name) {
  return ({ opacityValue }) =>
    opacityValue === undefined || String(opacityValue).startsWith("var(")
      ? `var(${name})`
      : `color-mix(in srgb, var(${name}) calc(${opacityValue} * 100%), transparent)`;
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Every value binds to a custom property in src/theme/tokens.css, so the day and night
      // token sets switch the whole UI without touching class names.
      colors: {
        background: {
          DEFAULT: token("--color-background"),
          secondary: token("--color-background-secondary"),
          tertiary: token("--color-background-tertiary"),
        },
        surface: token("--color-surface"),
        scrim: token("--color-scrim"),
        text: {
          DEFAULT: token("--color-text"),
          secondary: token("--color-text-secondary"),
          tertiary: token("--color-text-tertiary"),
        },
        accent: {
          DEFAULT: token("--color-accent"),
          hover: token("--color-accent-hover"),
          soft: token("--color-accent-soft"),
          on: token("--color-on-accent"),
        },
        gold: token("--color-gold"),
        green: token("--color-green"),
        border: {
          DEFAULT: token("--color-border"),
          focus: token("--color-border-focus"),
        },
        danger: token("--color-error"),
        success: token("--color-success"),
        warning: token("--color-warning"),
        dome: {
          DEFAULT: token("--dome-ground"),
          2: token("--dome-ground-2"),
          on: token("--on-dome"),
        },
      },
      fontFamily: {
        serif: ["Ibarra Real Nova", "Georgia", "serif"],
        display: ["Ibarra Real Nova", "Georgia", "serif"],
        sans: ["Jost", "system-ui", "sans-serif"],
        "arabic-display": ["Amiri", "Scheherazade New", "serif"],
        arabic: ["IBM Plex Sans Arabic", "Noto Naskh Arabic", "sans-serif"],
      },
      borderRadius: {
        DEFAULT: "10px",
        card: "14px",
      },
      boxShadow: {
        xs: "var(--shadow-xs)",
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        xl: "var(--shadow-xl)",
        "2xl": "var(--shadow-2xl)",
      },
      transitionDuration: {
        fast: "var(--duration-fast)",
        normal: "var(--duration-normal)",
      },
    },
  },
  plugins: [],
};
