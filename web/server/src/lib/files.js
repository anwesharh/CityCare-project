// src/lib/files.js — store uploaded reports/prescriptions in MongoDB (GridFS), so no extra storage service is needed
import mongoose from 'mongoose';
import multer from 'multer';

export const ALLOWED_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const MAX_BYTES = (process.env.VERCEL ? 4 : 8) * 1024 * 1024; // Vercel's request limit is 4.5 MB

/** Express middleware: one file in field "file", kept in memory, 8 MB max, PDF/JPG/PNG/WEBP only. */
export const uploadOne = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => (ALLOWED_TYPES[file.mimetype]
    ? cb(null, true)
    : cb(Object.assign(new Error('Only PDF, JPG, PNG or WEBP files'), { status: 400 }))),
}).single('file');

/** Wraps uploadOne so multer errors become clean 400 responses. */
export function receiveFile(req, res, next) {
  uploadOne(req, res, (err) => {
    if (!err) return next();
    const msg = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${MAX_BYTES / 1048576} MB` : err.message;
    return res.status(400).json({ error: msg });
  });
}

const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'uploads' });

const safeName = (n) => String(n || 'file').replace(/[^\w.\- ]+/g, '_').slice(0, 120);

export function saveFile(file, meta = {}) {
  return new Promise((resolve, reject) => {
    const name = safeName(file.originalname);
    const stream = bucket().openUploadStream(name, { contentType: file.mimetype, metadata: meta });
    stream.on('error', reject);
    stream.on('finish', () => resolve({ id: stream.id, name, contentType: file.mimetype, size: file.size }));
    stream.end(file.buffer);
  });
}

/** Stream a stored file to the response (inline, so PDFs/images open in the browser). */
export function sendFile(res, info) {
  res.setHeader('Content-Type', info.contentType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${safeName(info.name)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const s = bucket().openDownloadStream(new mongoose.Types.ObjectId(String(info.id)));
  s.on('error', () => { if (!res.headersSent) res.status(404).json({ error: 'File not found' }); else res.end(); });
  s.pipe(res);
}

export async function readFile(id) {
  const chunks = [];
  for await (const c of bucket().openDownloadStream(new mongoose.Types.ObjectId(String(id)))) chunks.push(c);
  return Buffer.concat(chunks);
}

export async function deleteFile(id) {
  if (!id) return;
  try { await bucket().delete(new mongoose.Types.ObjectId(String(id))); } catch { /* already gone */ }
}
