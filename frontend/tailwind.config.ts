import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{js,ts,jsx,tsx,mdx}",
    "./src/components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: "#F5F7FA",
        ink: {
          900: "#0B1F33",
          800: "#12304E",
          700: "#1D4266",
          500: "#476780",
          400: "#6B859A",
        },
        navy: {
          950: "#061423",
          900: "#0A1E33",
          800: "#102A45",
          700: "#173B5C",
          600: "#205078",
        },
        accent: {
          50: "#EEF7F6",
          100: "#D6EBE8",
          200: "#AED8D2",
          500: "#2E9C8E",
          600: "#1F8378",
          700: "#176A61",
        },
        line: "#E3E9EF",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      fontSize: {
        "2xs": ["0.6875rem", { lineHeight: "1rem" }],
      },
      borderRadius: {
        card: "10px",
        control: "8px",
      },
      boxShadow: {
        card: "0 1px 2px rgba(11,31,51,0.04), 0 6px 18px rgba(11,31,51,0.05)",
        raised: "0 12px 32px rgba(11,31,51,0.10)",
        modal: "0 24px 64px rgba(6,20,35,0.24)",
      },
      transitionTimingFunction: {
        spring: "cubic-bezier(0.22, 1, 0.36, 1)",
        smooth: "cubic-bezier(0.4, 0, 0.2, 1)",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "toast-in": {
          from: { opacity: "0", transform: "translateX(12px) scale(0.99)" },
          to: { opacity: "1", transform: "translateX(0) scale(1)" },
        },
        shimmer: { "100%": { transform: "translateX(100%)" } },
      },
      animation: {
        "fade-in": "fade-in 180ms cubic-bezier(0.22,1,0.36,1) both",
        "slide-up": "slide-up 220ms cubic-bezier(0.22,1,0.36,1) both",
        "toast-in": "toast-in 220ms cubic-bezier(0.22,1,0.36,1) both",
        shimmer: "shimmer 1.6s infinite",
      },
    },
  },
  plugins: [],
};

export default config;
