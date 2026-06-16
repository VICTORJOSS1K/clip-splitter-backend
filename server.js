/**
 * Clip Splitter AI - Backend de procesamiento
 * ------------------------------------------------
 * POST /jobs            -> { url, clipLength, format } => { jobId }
 * GET  /jobs/:id        -> { status, progress, clips, zipUrl, error }
 * GET  /files/:id/:name -> descarga de un clip o del ZIP
 *
 * Procesa con yt-dlp (descarga) + ffmpeg (corte por segmentos).
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { nanoid } = require('nanoid');
const archiver = require('archiver');

const PORT = process.env.PORT || 8080;
const API_TOKEN = process.env.API_TOKEN || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const WORK_DIR = process.env.WORK_DIR || '/tmp/clipsplitter';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const RETENTION_HOURS = Number(process.env.RETENTION_HOURS || 6);
const YTDLP_FORMAT = process.env.YTDLP_FORMAT || 'bv*[height<=1080]+ba/b[height<=1080]/best';

fs.mkdirSync(WORK_DIR, { recursive: true });

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: '1mb' }));

// ---- auth simple por bearer token ----
function auth(req, res, next) {
  if (!API_TOKEN) return next();
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (token !== API_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ---- estado en memoria de los jobs ----
/** @type {Map<string, any>} */
const jobs = new Map();

function publicUrl(jobId, filename) {
  const base = PUBLIC_BASE_URL || '';
  return `${base}/files/${jobId}/${encodeURIComponent(filename)}`;
}

// ---- helpers de proceso ----
function run(cmd, args, { onStderr } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stdout.on('data', () => {});
    p.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onStderr) onStderr(s);
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

// Duración del archivo mediante ffprobe
async function probeDuration(filepath) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filepath,
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      const sec = parseFloat(out.trim());
      if (!isFinite(sec)) return reject(new Error('invalid duration'));
      resolve(sec);
    });
  });
}

// Mapea el "format" del frontend a flags ffmpeg
function formatToFilter(format) {
  // tiktok / shorts / reels = 9:16 1080x1920, original = sin tocar
  switch (format) {
    case 'tiktok':
    case 'shorts':
    case 'reels':
      return [
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '128k',
      ];
    case 'original':
    default:
      // copy stream cuando sea posible (corte rápido en keyframes)
      return ['-c', 'copy', '-avoid_negative_ts', '1'];
  }
}

// ---- procesado principal ----
async function processJob(jobId, { url, clipLength, format }) {
  const job = jobs.get(jobId);
  const dir = path.join(WORK_DIR, jobId);
  await fsp.mkdir(dir, { recursive: true });

  try {
    // 1) Descargar con yt-dlp
    job.status = 'fetching';
    job.progress = 5;
    const sourcePath = path.join(dir, 'source.%(ext)s');
    await run('yt-dlp', [
      '-f', YTDLP_FORMAT,
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '-o', sourcePath,
      url,
    ], {
      onStderr: (s) => {
        const m = s.match(/(\d+(?:\.\d+)?)%/);
        if (m) {
          const pct = Math.min(40, 5 + (parseFloat(m[1]) * 0.35));
          job.progress = Math.max(job.progress, Math.round(pct));
        }
      },
    });

    // Encontrar el archivo descargado
    const files = await fsp.readdir(dir);
    const source = files.find((f) => f.startsWith('source.'));
    if (!source) throw new Error('No se pudo descargar el video');
    const sourceFull = path.join(dir, source);

    // 2) Medir duración
    job.status = 'splitting';
    job.progress = 45;
    const totalSec = await probeDuration(sourceFull);
    const length = Math.max(5, Math.floor(clipLength));
    const count = Math.max(1, Math.ceil(totalSec / length));

    // 3) Cortar con ffmpeg segmentado
    const outPattern = path.join(dir, 'parte_%03d.mp4');
    const formatFlags = formatToFilter(format);

    // Usamos segment muxer para cortes uniformes
    const segmentArgs = [
      '-y',
      '-i', sourceFull,
      ...formatFlags,
      '-f', 'segment',
      '-segment_time', String(length),
      '-reset_timestamps', '1',
      outPattern,
    ];

    await run('ffmpeg', segmentArgs, {
      onStderr: (s) => {
        const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (m) {
          const cur = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
          const pct = 45 + Math.min(45, (cur / totalSec) * 45);
          job.progress = Math.max(job.progress, Math.round(pct));
        }
      },
    });

    // 4) Renombrar a Parte_N.mp4 y construir lista
    const produced = (await fsp.readdir(dir))
      .filter((f) => /^parte_\d+\.mp4$/.test(f))
      .sort();

    const clips = [];
    for (let i = 0; i < produced.length; i++) {
      const oldName = produced[i];
      const newName = `Parte_${i + 1}.mp4`;
      await fsp.rename(path.join(dir, oldName), path.join(dir, newName));
      const start = i * length;
      const end = Math.min(totalSec, (i + 1) * length);
      clips.push({
        index: i + 1,
        name: newName,
        start,
        end,
        downloadUrl: publicUrl(jobId, newName),
      });
    }

    // 5) Crear ZIP
    job.progress = 95;
    const zipName = `clips_${jobId}.zip`;
    const zipPath = path.join(dir, zipName);
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(zipPath);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      for (const c of clips) archive.file(path.join(dir, c.name), { name: c.name });
      archive.finalize();
    });

    // Limpiar el source para ahorrar espacio
    try { await fsp.unlink(sourceFull); } catch {}

    job.status = 'done';
    job.progress = 100;
    job.clips = clips;
    job.zipUrl = publicUrl(jobId, zipName);
    job.totalDuration = totalSec;
    job.count = count;
    job.finishedAt = Date.now();
  } catch (err) {
    job.status = 'error';
    job.error = err.message || String(err);
  }
}

// ---- rutas ----
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/jobs', auth, (req, res) => {
  const { url, clipLength, format } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url requerida' });
  const len = Number(clipLength);
  if (!isFinite(len) || len < 5) return res.status(400).json({ error: 'clipLength inválido (mín 5s)' });

  const jobId = nanoid(10);
  jobs.set(jobId, {
    id: jobId,
    status: 'queued',
    progress: 0,
    url,
    clipLength: len,
    format: format || 'original',
    clips: [],
    zipUrl: null,
    error: null,
    createdAt: Date.now(),
  });

  // Disparar en background
  setImmediate(() => processJob(jobId, { url, clipLength: len, format }));

  res.json({ jobId });
});

app.get('/jobs/:id', auth, (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'job no encontrado' });
  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    clips: job.clips,
    zipUrl: job.zipUrl,
    error: job.error,
    count: job.count,
    totalDuration: job.totalDuration,
  });
});

// Descarga de archivos generados (clips o zip). Pública para que el navegador
// los pueda abrir directamente; los nombres llevan nanoid no adivinable.
app.get('/files/:id/:name', (req, res) => {
  const { id, name } = req.params;
  if (!/^[\w.-]+$/.test(name)) return res.status(400).end();
  const filePath = path.join(WORK_DIR, id, name);
  if (!filePath.startsWith(WORK_DIR)) return res.status(400).end();
  if (!fs.existsSync(filePath)) return res.status(404).end();
  res.download(filePath, name);
});

// ---- limpieza periódica ----
setInterval(async () => {
  const cutoff = Date.now() - RETENTION_HOURS * 3600 * 1000;
  try {
    const dirs = await fsp.readdir(WORK_DIR);
    for (const d of dirs) {
      const full = path.join(WORK_DIR, d);
      const stat = await fsp.stat(full).catch(() => null);
      if (stat && stat.isDirectory() && stat.mtimeMs < cutoff) {
        await fsp.rm(full, { recursive: true, force: true });
        jobs.delete(d);
      }
    }
  } catch (e) {
    console.error('cleanup error', e);
  }
}, 30 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Clip Splitter backend escuchando en :${PORT}`);
});
  
