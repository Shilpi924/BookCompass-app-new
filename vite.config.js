import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  envPrefix: ["VITE_", "GOOGLE_BOOKS_"],
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/react-dom")) {
            return "react";
          }

          if (id.includes("node_modules/@firebase") || id.includes("node_modules/firebase")) {
            return "firebase";
          }

          if (
            id.includes("node_modules/@capacitor") ||
            id.includes("node_modules/@capacitor-firebase")
          ) {
            return "capacitor";
          }
        },
      },
    },
  },
})
