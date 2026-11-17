import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';

import { Command } from 'commander';
import superagent from 'superagent';

import { buffer } from 'node:stream/consumers';

// Надсилання текстової відповіді клієнту.
function sendText(res, status, message) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
  });

  res.end(message);
}

// Надсилання картинки та заголовка з її джерелом.
function sendImage(res, image, source) {
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': image.length,
    'X-Cache': source,
    'Cache-Control': 'no-store',
  });

  res.end(image);
}

// Запис через тимчасовий файл, щоб клієнт
// не прочитав частково записану картинку.
async function saveImage(filePath, image) {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, image);
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

// Обробка GET-запиту.
async function handleGet(res, filePath, code) {
  // Спочатку шукаємо картинку в кеші.
  try {
    const image = await readFile(filePath);

    sendImage(res, image, 'CACHE');
    return;
  } catch (error) {
    // ENOENT означає, що файлу немає.
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  // Якщо файлу немає, завантажуємо його з http.cat.
  let image;

  try {
    const response = await superagent
      .get(`https://http.cat/${code}`)
      .responseType('blob')
      .timeout({
        response: 10000,
        deadline: 20000,
      });

    const contentType = response.headers['content-type'] ?? '';

    if (
      !contentType.toLowerCase().startsWith('image/jpeg') ||
      !Buffer.isBuffer(response.body) ||
      response.body.length === 0
    ) {
      throw new Error('Зовнішній сервер не повернув JPEG-картинку');
    }

    image = response.body;
  } catch (error) {
    console.error(`Помилка http.cat для ${code}:`, error.message);

    sendText(
      res,
      404,
      'Картинку не знайдено або http.cat недоступний',
    );
    return;
  }

  // Спочатку зберігаємо картинку, потім надсилаємо клієнту.
  await saveImage(filePath, image);
  sendImage(res, image, 'HTTP_CAT');
}

// Отримання картинки з тіла PUT-запиту.
async function handlePut(req, res, filePath) {
  // Читаємо потік запиту в Buffer через проміс.
  const image = await buffer(req);

  if (image.length === 0) {
    sendText(res, 400, 'Тіло запиту не може бути порожнім');
    return;
  }

  // Зберігаємо отримані байти без змін.
  await saveImage(filePath, image);

  sendText(res, 201, 'Картинку збережено в кеші');
}

// Видалення картинки з кешу.
async function handleDelete(res, filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendText(res, 404, 'Картинки немає в кеші');
      return;
    }

    // Інші помилки передаємо загальному обробнику.
    throw error;
  }

  sendText(res, 200, 'Картинку видалено з кешу');
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

      const code = match[1];
      const filePath = path.join(cacheDirectory, `${code}.jpg`);

      if (req.method === 'GET') {
        await handleGet(res, filePath, code);
        return;
      }

      if (req.method === 'PUT') {
        await handlePut(req, res, filePath);
        return;
      }

      await handleDelete(res, filePath);
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