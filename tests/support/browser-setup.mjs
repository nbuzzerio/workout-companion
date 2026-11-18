import { preview } from 'vite';
import { fixture } from './local-service.mjs';

// Own both services directly, including explicit teardown. This avoids Windows
// process-tree termination permissions and never reuses an unknown live service.
export default async function setup() {
  const backend = await fixture('http://127.0.0.1:5174', 4317);
  let frontend;
  try {
    frontend = await preview({ preview: { port: 5174, strictPort: true, host: '127.0.0.1', proxy: { '/api/v1': { target: 'http://127.0.0.1:4317', changeOrigin: false } } } });
  } catch (error) { await backend.close(); throw error; }
  return async () => { frontend.httpServer.closeAllConnections(); await new Promise(resolve => frontend.httpServer.close(resolve)); await backend.close(); };
}
