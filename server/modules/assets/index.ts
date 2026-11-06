// Express router mounted at /api/assets by server/index.ts for uploading and
// serving chat attachments stored in the global ~/.cloudcli/assets folder.
export { default as assetsRoutes } from './assets.routes.js';

// WebSocket and Providers retain managed attachments when a message is admitted.
export { retainAttachmentUploads } from './services/chunk-upload.service.js';
