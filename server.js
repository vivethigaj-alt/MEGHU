const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATABASE_PATH = path.resolve(process.env.BOOKINGS_DB_PATH || path.join(DATA_DIR, 'bookings.sqlite'));
const PORT = Number(process.env.PORT || 3000);
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const MAX_REQUEST_BYTES = 16 * 1024;
const VEHICLES = new Set(['Urbania', 'Innova Crysta', 'Etios', 'Traveller', 'Bus']);
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png'
};

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT must be a valid TCP port number.');
}

if (Buffer.byteLength(ADMIN_API_KEY) < 32) {
  throw new Error('Set ADMIN_API_KEY to a secret that is at least 32 bytes long.');
}

fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
const database = new DatabaseSync(DATABASE_PATH);
database.exec(`
  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    pickup TEXT NOT NULL,
    dropoff TEXT NOT NULL,
    travel_date TEXT NOT NULL,
    vehicle TEXT NOT NULL,
    passengers INTEGER NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  )
`);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

function isAdmin(request) {
  const authorization = request.headers.authorization || '';
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match) return false;

  const supplied = Buffer.from(match[1]);
  const expected = Buffer.from(ADMIN_API_KEY);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
        tooLarge = true;
        body = '';
      }
    });
    request.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function validateBooking(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Booking details must be a JSON object.';
  }

  const requiredStrings = ['name', 'phone', 'pickup', 'dropoff', 'travelDate', 'vehicle'];
  for (const field of requiredStrings) {
    if (typeof value[field] !== 'string' || !value[field].trim()) {
      return `${field} is required.`;
    }
  }

  if (value.name.trim().length > 100) return 'Name must be 100 characters or fewer.';
  if (!/^[+\d\s().-]{7,20}$/.test(value.phone.trim())) return 'Enter a valid phone number.';
  if (value.pickup.trim().length > 200 || value.dropoff.trim().length > 200) {
    return 'Locations must be 200 characters or fewer.';
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.travelDate) ||
      Number.isNaN(Date.parse(`${value.travelDate}T00:00:00Z`)) ||
      new Date(`${value.travelDate}T00:00:00Z`).toISOString().slice(0, 10) !== value.travelDate) {
    return 'Enter a valid travel date.';
  }
  if (!VEHICLES.has(value.vehicle)) return 'Select a valid vehicle.';
  if (!Number.isInteger(value.passengers) || value.passengers < 1 || value.passengers > 100) {
    return 'Passengers must be a whole number between 1 and 100.';
  }
  if (value.message !== undefined &&
      (typeof value.message !== 'string' || value.message.length > 2000)) {
    return 'Message must be 2000 characters or fewer.';
  }
  return null;
}

function serveStatic(request, response, pathname) {
  const requestedPath = pathname === '/' ? '/meghu.html' : decodeURIComponent(pathname);
  const filePath = path.resolve(ROOT, `.${requestedPath}`);
  if (!filePath.startsWith(`${ROOT}${path.sep}`)) {
    sendJson(response, 400, { error: 'Invalid file path.' });
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  if (!MIME_TYPES[extension]) {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      sendJson(response, error.code === 'ENOENT' ? 404 : 500, {
        error: error.code === 'ENOENT' ? 'Not found.' : 'Could not read the requested file.'
      });
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extension],
      'X-Content-Type-Options': 'nosniff'
    });
    if (request.method === 'HEAD') {
      response.end();
    } else {
      response.end(contents);
    }
  });
}

const server = http.createServer(async (request, response) => {
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  } catch {
    sendJson(response, 400, { error: 'Invalid request URL.' });
    return;
  }

  if (url.pathname === '/api/bookings' && request.method === 'POST') {
    try {
      const booking = await readJson(request);
      const validationError = validateBooking(booking);
      if (validationError) {
        sendJson(response, 400, { error: validationError });
        return;
      }

      const result = database.prepare(`
        INSERT INTO bookings (name, phone, pickup, dropoff, travel_date, vehicle, passengers, message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        booking.name.trim(),
        booking.phone.trim(),
        booking.pickup.trim(),
        booking.dropoff.trim(),
        booking.travelDate,
        booking.vehicle,
        booking.passengers,
        (booking.message || '').trim()
      );
      sendJson(response, 201, { message: 'Booking request received.', id: Number(result.lastInsertRowid) });
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) {
        sendJson(response, error.statusCode || 500, {
          error: error.statusCode ? error.message : 'Could not save the booking request.'
        });
      }
    }
    return;
  }

  if (url.pathname === '/api/bookings' && request.method === 'GET') {
    if (!isAdmin(request)) {
      sendJson(response, 401, { error: 'A valid admin bearer token is required.' });
      return;
    }

    const limitParameter = url.searchParams.get('limit') || '50';
    const offsetParameter = url.searchParams.get('offset') || '0';
    const limit = Number(limitParameter);
    const offset = Number(offsetParameter);
    if (!/^\d+$/.test(limitParameter) || !/^\d+$/.test(offsetParameter) ||
        !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isSafeInteger(offset) || offset < 0) {
      sendJson(response, 400, { error: 'Use a limit from 1 to 100 and a non-negative offset.' });
      return;
    }

    const bookings = database.prepare(`
      SELECT id, name, phone, pickup, dropoff, travel_date AS travelDate,
             vehicle, passengers, message, created_at AS createdAt
      FROM bookings ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
    sendJson(response, 200, { bookings, limit, offset });
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'API endpoint not found.' });
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { error: 'Method not allowed.' });
    return;
  }
  try {
    serveStatic(request, response, url.pathname);
  } catch {
    sendJson(response, 400, { error: 'Invalid file path.' });
  }
});

server.listen(PORT, process.env.HOST || '127.0.0.1', () => {
  console.log(`Meghu Holidays server listening on http://${process.env.HOST || '127.0.0.1'}:${PORT}`);
});

function closeServer() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on('SIGINT', closeServer);
process.on('SIGTERM', closeServer);
