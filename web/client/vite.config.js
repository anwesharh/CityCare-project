import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// During development, /api calls go to the Express server on port 4000.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
  },
});
