/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // All values bind to the CSS custom properties defined in src/index.css so the
      // tokens stay single-source. Purple theme (#450377 / #9667ba) replaces the base theme's
      // burgundy; cream backgrounds and slate text are inherited unchanged.
      colors: {
        background: {
          DEFAULT: "var(--color-background)",
          secondary: "var(--color-background-secondary)",
          tertiary: "var(--color-background-tertiary)",
        },
        text: {
          DEFAULT: "var(--color-text)",
          secondary: "var(--color-text-secondary)",
          tertiary: "var(--color-text-tertiary)",
        },
        accent: {
          DEFAULT: "var(--color-accent)",
          hover: "var(--color-accent-hover)",
          secondary: "var(--color-accent-secondary)",
          soft: "var(--color-accent-soft)",
        },
        border: {
          DEFAULT: "var(--color-border)",
          focus: "var(--color-border-focus)",
        },
        danger: "var(--color-error)",
        success: "var(--color-success)",
        warning: "var(--color-warning)",
        info: "var(--color-info)",
      },
      fontFamily: {
        serif: ["Ibarra Real Nova", "Georgia", "serif"],
        sans: ["Futura", "system-ui", "sans-serif"],
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
        fast: "150ms",
        normal: "250ms",
      },
    },
  },
  plugins: [],
};
