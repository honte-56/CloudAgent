import express from 'express';
import type { ErrorRequestHandler } from 'express';

/** Used by server bootstrap to parse request bodies before authentication without decompressing untrusted input. */
export function createRequestBodyMiddleware(): express.Router {
  const router = express.Router();

  // Clients send uncompressed JSON/forms. Reject compressed bodies before a
  // decompressor can be created (GHSA-27r3-jxmh-p828), including on public routes.
  router.use(express.json({
    limit: '50mb',
    inflate: false,
    type: (request) => {
      const contentType = request.headers['content-type'] || '';
      // Upload middleware must receive the untouched multipart stream.
      return !contentType.includes('multipart/form-data') && contentType.includes('json');
    },
  }));
  router.use(express.urlencoded({ limit: '50mb', extended: true, inflate: false }));

  const handleParsingError: ErrorRequestHandler = (error: unknown, _request, response, next) => {
    const status = error instanceof Error && 'status' in error ? error.status : undefined;
    if (status !== 400 && status !== 413 && status !== 415) {
      next(error);
      return;
    }

    // Do not log or echo parser error bodies: login requests contain passwords.
    const failure = status === 415
      ? { code: 'UNSUPPORTED_REQUEST_ENCODING', message: 'Unsupported request encoding. Send an uncompressed body with a supported charset.' }
      : status === 413
        ? { code: 'REQUEST_BODY_TOO_LARGE', message: 'Request body exceeds the parsing limits.' }
        : { code: 'INVALID_REQUEST_BODY', message: 'Invalid request body.' };
    response.status(status).json({ success: false, error: failure });
  };
  router.use(handleParsingError);

  return router;
}
