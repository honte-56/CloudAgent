/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      fontFamily: {
        // The platform's own UI face on every OS, with CJK faces ahead of the
        // generic fallback so mixed Chinese/Latin text keeps one rhythm.
        sans: [
          'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI Variable Text"', '"Segoe UI"', 'Roboto',
          '"PingFang SC"', '"Hiragino Sans GB"', '"Noto Sans SC"', '"Microsoft YaHei"', '"Helvetica Neue"', 'Arial', 'sans-serif',
        ],
        // Kept as an alias so existing font-serif call sites read in the UI face.
        serif: [
          'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI Variable Text"', '"Segoe UI"', 'Roboto',
          '"PingFang SC"', '"Hiragino Sans GB"', '"Noto Sans SC"', '"Microsoft YaHei"', 'sans-serif',
        ],
      },
      colors: {
        // A neutral ramp tinted with the seed hue, so the many hard-coded
        // gray-* classes sit on the same tonal scale as the theme tokens.
        gray: {
          50: '#f7f8fb',
          100: '#eef0f4',
          200: '#dfe2ea',
          300: '#c7ccd6',
          400: '#979eaa',
          500: '#6c727f',
          600: '#515661',
          700: '#3c4049',
          800: '#272a2f',
          900: '#1a1c20',
          950: '#101114',
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        chrome: {
          DEFAULT: "hsl(var(--chrome))",
          foreground: "hsl(var(--chrome-foreground))",
        },
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          container: "hsl(var(--primary-container))",
          "container-foreground": "hsl(var(--primary-container-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      // One radius scale for the whole app: controls are pills, rows are 12,
      // cards 16–20, panels and sheets 24–28. Rounder layers sit further back.
      borderRadius: {
        sm: "calc(var(--radius) - 4px)",
        md: "calc(var(--radius) - 2px)",
        lg: "var(--radius)",
        xl: "16px",
        "2xl": "20px",
        "3xl": "24px",
        "4xl": "28px",
      },
      boxShadow: {
        raised: "var(--shadow-raised)",
        floating: "var(--shadow-floating)",
      },
      spacing: {
        'safe-area-inset-bottom': 'env(safe-area-inset-bottom)',
      },
      transitionTimingFunction: {
        standard: 'var(--ease-standard)',
        exit: 'var(--ease-exit)',
        'spring-smooth': 'var(--spring-smooth)',
        'spring-snappy': 'var(--spring-snappy)',
        'spring-bouncy': 'var(--spring-bouncy)',
        'spring-press': 'var(--spring-press)',
      },
      transitionDuration: {
        'spring-smooth': 'var(--spring-smooth-duration)',
        'spring-snappy': 'var(--spring-snappy-duration)',
        'spring-bouncy': 'var(--spring-bouncy-duration)',
        'spring-press': 'var(--spring-press-duration)',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '200% 0' },
          '100%': { backgroundPosition: '-200% 0' },
        },
        'dialog-overlay-show': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'dialog-content-show': {
          from: { opacity: '0', transform: 'translate(-50%, -50%) scale(0.92)' },
          to: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' },
        },
        'bottom-sheet-content-show': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
        // A floating surface (menu, popover) growing out of its anchor.
        'pop-in': {
          from: { opacity: '0', transform: 'scale(0.9)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        // A view replacing another in place: arrives slightly small and low.
        'fade-through': {
          from: { opacity: '0', transform: 'translateY(6px) scale(0.985)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        // New content joining a list or transcript from below.
        'rise-in': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
      },
      animation: {
        shimmer: 'shimmer 2s linear infinite',
        'dialog-overlay-show': 'dialog-overlay-show 200ms var(--ease-standard)',
        'dialog-content-show': 'dialog-content-show var(--spring-bouncy-duration) var(--spring-bouncy)',
        'bottom-sheet-content-show': 'bottom-sheet-content-show var(--spring-smooth-duration) var(--spring-smooth)',
        'pop-in': 'pop-in var(--spring-bouncy-duration) var(--spring-bouncy) backwards',
        'fade-through': 'fade-through var(--spring-smooth-duration) var(--spring-smooth) backwards',
        'rise-in': 'rise-in var(--spring-smooth-duration) var(--spring-smooth) backwards',
        'fade-in': 'fade-in 200ms var(--ease-standard) backwards',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
