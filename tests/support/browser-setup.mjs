import { preview } from 'vite';

// The preview is shared. Each test owns a fresh loopback API and SQLite database.
export default async function setup() {
  const port = Number(process.env.WORKOUT_SYNC_TEST_PORT ?? 4317);
  const frontend = await preview({ preview: { port: 5174, strictPort: true, host: '127.0.0.1', proxy: { '/api/v1': { target: `http://127.0.0.1:${port}`, changeOrigin: false } } } });
  return async () => { frontend.httpServer.closeAllConnections(); await new Promise(resolve => frontend.httpServer.close(resolve)); };
}
