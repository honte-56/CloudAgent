import express from 'express';
import multer from 'multer';

import { createRequestBodyMiddleware } from '../../index.js';

// A standalone child process makes an uncaught decompressor error observable
// without starting the real application, opening a database, or touching files.
const app = express();
app.use(createRequestBodyMiddleware());
app.get('/health', (_request, response) => { response.json({ status: 'ok' }); });
app.post('/echo', (request, response) => { response.json(request.body); });
app.post('/protected', (_request, response) => { response.sendStatus(401); });
app.post('/upload', multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 } }).single('file'), (request, response) => {
  response.json({ field: request.body.field, file: request.file?.buffer.toString('utf8') });
});

const server = app.listen(0, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') process.send?.({ port: address.port });
});

process.on('SIGTERM', () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
