// Адрес API (Cloudflare Worker). После `npx wrangler deploy` вставьте сюда свой адрес.
window.APP_CONFIG = {
  API_URL: 'https://love-achievements-api.matvey2568.workers.dev',
};

// Для локальной разработки (http://localhost) используется локальный worker.
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  window.APP_CONFIG.API_URL = 'http://localhost:8787';
}
