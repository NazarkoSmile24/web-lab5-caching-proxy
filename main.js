import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { Command } from 'commander';

// Надсилання текстової відповіді клієнту.
function sendText(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
  });

  res.end(message);
}

async function main() {
  const program = new Command();

  program
    .name('caching-proxy')
    .description('Кешуючий проксі-сервер для http.cat')
    // Використовуємо --help, щоб звільнити -h для host.
    .helpOption('--help', 'Показати довідку')
    .requiredOption('-h, --host <address>', 'Адреса сервера')
    .requiredOption('-p, --port <number>', 'Порт сервера')
    .requiredOption('-c, --cache <path>', 'Шлях до теки кешу');

  program.parse();

  const options = program.opts();

  if (options.host.trim() === '') {
    throw new Error('Адреса сервера не може бути порожньою');
  }

  if (!/^\d+$/.test(options.port)) {
    throw new Error('Порт має бути цілим числом');
  }

  const port = Number(options.port);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Порт має бути від 1 до 65535');
  }

  if (options.cache.trim() === '') {
    throw new Error('Шлях до кешу не може бути порожнім');
  }

  const cacheDirectory = path.resolve(options.cache);

  // Створюємо теку кешу до запуску сервера.
  await mkdir(cacheDirectory, { recursive: true });

  const server = http.createServer(async (req, res) => {
    try {
      if (
        req.method !== 'GET' &&
        req.method !== 'PUT' &&
        req.method !== 'DELETE'
      ) {
        res.setHeader('Allow', 'GET, PUT, DELETE');
        sendText(res, 405, 'Метод не дозволений');
        return;
      }

      // Дозволяємо лише / і тризначне число.
      const match = /^\/([1-9]\d{2})$/.exec(req.url ?? '');

      if (!match) {
        sendText(res, 400, 'Шлях має бути у форматі /200');
        return;
      }

      // Методи реалізуємо на наступних етапах.
      sendText(res, 501, 'Метод ще не реалізовано');
    } catch (error) {
      console.error('Помилка обробки запиту:', error.message);

      if (!res.headersSent && !res.destroyed) {
        sendText(res, 500, 'Внутрішня помилка сервера');
      } else if (!res.destroyed) {
        res.end();
      }
    }
  });

  server.listen(port, options.host);
  await once(server, 'listening');

  console.log(`Сервер: http://${options.host}:${port}`);
  console.log(`Тека кешу: ${cacheDirectory}`);
}

try {
  await main();
} catch (error) {
  console.error('Помилка запуску:', error.message);
  process.exitCode = 1;
}