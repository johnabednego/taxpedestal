/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Prussian ink — the base. Deliberately blue-black rather than neutral
        // grey so the whole product reads as "financial document", not "SaaS
        // dashboard template".
        ink: {
          DEFAULT: '#0B1B3A',
          900: '#0B1B3A',
          800: '#152A52',
          700: '#22396B',
          600: '#3B5488',
          500: '#5C74A3',
          400: '#8494BA',
          300: '#AEB9D1',
          200: '#D2D9E6',
          100: '#E8ECF3',
          50: '#F6F7F9',
        },
        cobalt: {
          DEFAULT: '#2B59FF',
          700: '#1E3FCC',
          600: '#2449E6',
          500: '#2B59FF',
          400: '#5C7EFF',
          300: '#93AAFF',
          100: '#E4EAFF',
          50: '#F1F4FF',
        },
        // Reserved for "settled". Never used decoratively, so green always
        // means money arrived.
        jade: { DEFAULT: '#0E9F6E', 700: '#077F57', 100: '#DCFAEE', 50: '#EFFDF7' },
        amber: { DEFAULT: '#B45309', 700: '#92400E', 100: '#FEF3C7', 50: '#FFFBEB' },
        rose: { DEFAULT: '#BE123C', 700: '#9F1239', 100: '#FFE4E6', 50: '#FFF1F2' },
      },
      fontFamily: {
        display: ['"Bricolage Grotesque"', 'system-ui', 'sans-serif'],
        sans: ['"Inter Tight"', 'system-ui', '-apple-system', 'sans-serif'],
        // Every monetary figure uses this. Tabular digits align in columns the
        // way a ledger should, which is the first thing a finance person checks.
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem', letterSpacing: '0.02em' }],
      },
      letterSpacing: { tightest: '-0.04em' },
      boxShadow: {
        card: '0 1px 2px rgba(11,27,58,0.04), 0 4px 16px -4px rgba(11,27,58,0.08)',
        lift: '0 2px 4px rgba(11,27,58,0.04), 0 12px 32px -8px rgba(11,27,58,0.16)',
        stamp: '0 0 0 3px rgba(14,159,110,0.12)',
      },
      borderRadius: { xl: '0.875rem', '2xl': '1.125rem' },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'stamp-in': {
          '0%': { opacity: '0', transform: 'scale(1.6) rotate(-18deg)' },
          '60%': { opacity: '1', transform: 'scale(0.94) rotate(-11deg)' },
          '100%': { opacity: '1', transform: 'scale(1) rotate(-12deg)' },
        },
        shimmer: { '100%': { transform: 'translateX(100%)' } },
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.4s cubic-bezier(0.16,1,0.3,1) both',
        'stamp-in': 'stamp-in 0.5s cubic-bezier(0.16,1,0.3,1) both',
        shimmer: 'shimmer 1.6s infinite',
        'slide-in': 'slide-in 0.25s cubic-bezier(0.16,1,0.3,1) both',
      },
    },
  },
  plugins: [],
}
