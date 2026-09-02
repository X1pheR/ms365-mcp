import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { getRequestTokens } from '@softeria/ms-365-mcp-server/dist/request-context.js';

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_TEMP_TTL_SECONDS = 24 * 60 * 60;
const IO_CHUNK_BYTES = 64 * 1024;
const META_FILE = '.hypershell-attachment.json';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DANGEROUS_EXTENSIONS = new Set([
  '.bat', '.cmd', '.com', '.dll', '.exe', '.hta', '.jar', '.jse', '.lnk', '.msi',
  '.ps1', '.scr', '.vbe', '.vbs', '.wsf', '.wsh',
]);

function parsePositiveInteger(raw, fallback, name) {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function parseAbsolutePath(raw, fallback, name) {
  const value = raw || fallback;
  if (!value || value.includes('\0') || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path without NUL bytes`);
  }
  return path.resolve(value);
}

export function loadAttachmentConfig(env = process.env) {
  const tempRoot = parseAbsolutePath(
    env.MS365_ATTACHMENT_TEMP_ROOT,
    '/tmp/ms365-mail-attachments',
    'MS365_ATTACHMENT_TEMP_ROOT',
  );
  const durableRoot = env.MS365_ATTACHMENT_DURABLE_ROOT
    ? parseAbsolutePath(env.MS365_ATTACHMENT_DURABLE_ROOT, undefined, 'MS365_ATTACHMENT_DURABLE_ROOT')
    : undefined;
  const hostTempRoot = env.MS365_ATTACHMENT_HOST_TEMP_ROOT
    ? parseAbsolutePath(env.MS365_ATTACHMENT_HOST_TEMP_ROOT, undefined, 'MS365_ATTACHMENT_HOST_TEMP_ROOT')
    : undefined;
  const hostDurableRoot = env.MS365_ATTACHMENT_HOST_DURABLE_ROOT
    ? parseAbsolutePath(env.MS365_ATTACHMENT_HOST_DURABLE_ROOT, undefined, 'MS365_ATTACHMENT_HOST_DURABLE_ROOT')
    : undefined;
  return {
    tempRoot,
    durableRoot,
    hostTempRoot,
    hostDurableRoot,
    maxBytes: parsePositiveInteger(env.MS365_ATTACHMENT_MAX_BYTES, DEFAULT_MAX_BYTES, 'MS365_ATTACHMENT_MAX_BYTES'),
    tempTtlSeconds: parsePositiveInteger(
      env.MS365_ATTACHMENT_TEMP_TTL_SECONDS,
      DEFAULT_TEMP_TTL_SECONDS,
      'MS365_ATTACHMENT_TEMP_TTL_SECONDS',
    ),
  };
}

function truncateUtf8(value, maxBytes) {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  for (const character of value) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break;
    result += character;
  }
  return result;
}

export function sanitizeFileName(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('file_name must be text without NUL bytes');
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) throw new Error('file_name must not be an absolute path');
  if (value.includes('/') || value.includes('\\')) throw new Error('file_name must contain a filename only, not path separators');
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized === '.' || normalized === '..') throw new Error('file_name is not usable');
  const sanitized = truncateUtf8(normalized.replace(/[\u0001-\u001f\u007f]/g, '_'), 240);
  if (!sanitized || sanitized === '.' || sanitized === '..') throw new Error('file_name is not usable');
  return sanitized;
}

function safeRemoteFileName(value, attachmentId) {
  try {
    return sanitizeFileName(value);
  } catch {
    const compact = String(attachmentId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
    return `attachment-${compact || randomUUID()}.bin`;
  }
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function ensureRoot(requested, mode = 0o700) {
  await fs.mkdir(requested, { recursive: true, mode });
  const stats = await fs.lstat(requested);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`Configured root is not a real directory: ${requested}`);
  return fs.realpath(requested);
}

function splitRelativeDirectory(value) {
  if (typeof value !== 'string' || value.includes('\0') || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    throw new Error('durable_relative_directory must be a relative directory');
  }
  if (value.includes('\\')) throw new Error('durable_relative_directory must use forward slashes');
  const segments = value.split('/').map((segment) => segment.normalize('NFC').trim());
  if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('durable_relative_directory contains an unsafe path segment');
  }
  return segments;
}

async function ensureSafeSubdirectory(root, relativeDirectory) {
  const segments = splitRelativeDirectory(relativeDirectory);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    const next = path.join(current, segment);
    if (!isWithin(root, next)) throw new Error('durable_relative_directory escapes the configured durable root');
    try {
      const stats = await fs.lstat(next);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`Unsafe durable path component: ${segment}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      if (index === 0) throw new Error(`Durable top-level owner does not exist: ${segment}`);
      await fs.mkdir(next, { mode: 0o700 });
    }
    current = await fs.realpath(next);
    if (!isWithin(root, current)) throw new Error('durable_relative_directory resolves outside the configured durable root');
  }
  return current;
}

async function fsyncDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP'].includes(error?.code)) throw error;
  } finally {
    await handle.close();
  }
}

async function targetState(filePath) {
  try {
    const stats = await fs.lstat(filePath);
    if (stats.isSymbolicLink()) throw new Error('Destination must not be a symbolic link');
    if (!stats.isFile()) throw new Error('Destination exists but is not a regular file');
    return 'file';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function publishNoClobber(tempPath, finalPath, overwrite) {
  const directory = path.dirname(finalPath);
  const before = await targetState(finalPath);
  if (before === 'file' && !overwrite) throw new Error(`Destination already exists: ${path.basename(finalPath)}`);
  if (overwrite) {
    await fs.rename(tempPath, finalPath);
    await fsyncDirectory(directory);
    return before === 'file';
  }
  try {
    await fs.link(tempPath, finalPath);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`Destination already exists: ${path.basename(finalPath)}`);
    throw error;
  }
  await fs.unlink(tempPath);
  await fsyncDirectory(directory);
  return false;
}

async function writeJsonAtomic(filePath, value) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.meta-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  let created = false;
  try {
    handle = await fs.open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
    created = false;
    await fsyncDirectory(directory);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    if (created) await fs.unlink(tempPath).catch(() => undefined);
  }
}

function mapHostPath(filePath, root, hostRoot) {
  if (!hostRoot) return undefined;
  const relative = path.relative(root, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return path.join(hostRoot, relative);
}

function detectMagic(prefix) {
  if (prefix.length >= 5 && prefix.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf';
  if (prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return 'png';
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) return 'jpeg';
  if (prefix.length >= 4 && prefix[0] === 0x50 && prefix[1] === 0x4b && [0x03,0x05,0x07].includes(prefix[2]) && [0x04,0x06,0x08].includes(prefix[3])) return 'zip';
  if (prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1]))) return 'ole';
  if (prefix.length >= 2 && prefix[0] === 0x4d && prefix[1] === 0x5a) return 'windows-executable';
  if (prefix.length >= 4 && prefix.subarray(0, 4).equals(Buffer.from([0x7f,0x45,0x4c,0x46]))) return 'elf-executable';
  return 'unknown';
}

function inspectContent(fileName, contentType, magic, declaredSize, actualSize) {
  const warnings = [];
  const extension = path.extname(fileName).toLowerCase();
  const mime = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  if (Number.isSafeInteger(declaredSize) && declaredSize >= 0 && declaredSize !== actualSize) {
    warnings.push(`Graph metadata size ${declaredSize} differs from downloaded size ${actualSize}`);
  }
  if ((extension === '.pdf' || mime === 'application/pdf') && magic !== 'pdf') {
    warnings.push('PDF name/MIME does not match the downloaded file signature');
  }
  if (['windows-executable', 'elf-executable'].includes(magic)) warnings.push(`Executable file signature detected: ${magic}`);
  if (DANGEROUS_EXTENSIONS.has(extension)) warnings.push(`Potentially executable or active-content extension: ${extension}`);
  return {
    magic,
    analysis_safe: !warnings.some((warning) => /executable|does not match/i.test(warning)),
    warnings,
  };
}

async function responseError(response, action) {
  await response.body?.cancel().catch(() => undefined);
  throw new Error(`${action} failed with Microsoft Graph HTTP ${response.status}`);
}

async function accessTokenFor(graphClient) {
  const requestTokens = getRequestTokens();
  const token = requestTokens?.accessToken ?? await graphClient.authManager.getToken();
  if (!token) throw new Error('No Microsoft Graph access token is available');
  return token;
}

async function fetchAttachmentMetadata(graphClient, messageId, attachmentId, accessToken) {
  const endpoint = `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}?$select=id,name,contentType,size,isInline`;
  const response = await graphClient.performRequest(endpoint, accessToken, { method: 'GET' });
  if (!response.ok) await responseError(response, 'Attachment metadata lookup');
  const metadata = await response.json();
  return {
    id: metadata.id,
    name: metadata.name,
    contentType: metadata.contentType,
    size: metadata.size,
    isInline: metadata.isInline === true,
    odataType: metadata['@odata.type'],
  };
}

function validateExpectedSha256(value) {
  if (value === undefined) return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(value)) throw new Error('expected_sha256 must be exactly 64 hexadecimal characters');
  return value.toLowerCase();
}

async function streamAttachmentToTemporaryFile(response, directory, maxBytes) {
  const contentLengthRaw = response.headers.get('content-length');
  if (contentLengthRaw && /^\d+$/.test(contentLengthRaw) && Number(contentLengthRaw) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Attachment exceeds maximum size of ${maxBytes} bytes`);
  }
  if (!response.body) throw new Error('Microsoft Graph returned an empty attachment body');

  const tempPath = path.join(directory, `.download-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  let created = false;
  try {
    handle = await fs.open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    const hash = createHash('sha256');
    const reader = response.body.getReader();
    let size = 0;
    let prefix = Buffer.alloc(0);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new Error(`Attachment exceeds maximum size of ${maxBytes} bytes`);
        }
        const chunk = Buffer.from(value);
        if (prefix.length < IO_CHUNK_BYTES) prefix = Buffer.concat([prefix, chunk.subarray(0, IO_CHUNK_BYTES - prefix.length)]);
        hash.update(chunk);
        await handle.write(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    return { tempPath, size, sha256: hash.digest('hex'), prefix };
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (created) await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function downloadAttachment(graphClient, params, config) {
  const expectedSha256 = validateExpectedSha256(params.expected_sha256);
  const accessToken = await accessTokenFor(graphClient);
  const metadata = await fetchAttachmentMetadata(graphClient, params.message_id, params.attachment_id, accessToken);
  if (metadata.odataType !== '#microsoft.graph.fileAttachment') {
    throw new Error(`Unsupported attachment type: ${metadata.odataType || 'unknown'}; only fileAttachment is supported`);
  }
  if (metadata.isInline && params.allow_inline !== true) throw new Error('Inline attachment blocked; set allow_inline=true only when it is intentionally needed');
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) throw new Error('Attachment metadata contains an invalid size');
  if (metadata.size > config.maxBytes) throw new Error(`Attachment exceeds maximum size of ${config.maxBytes} bytes`);

  const fileName = params.file_name ? sanitizeFileName(params.file_name) : safeRemoteFileName(metadata.name, params.attachment_id);
  let root;
  let directory;
  let artifactId;
  let hostRoot;
  if (params.mode === 'durable') {
    if (!config.durableRoot) throw new Error('Durable attachment storage is disabled');
    root = await ensureRoot(config.durableRoot);
    directory = await ensureSafeSubdirectory(root, params.durable_relative_directory);
    hostRoot = config.hostDurableRoot;
  } else {
    root = await ensureRoot(config.tempRoot);
    artifactId = randomUUID();
    directory = path.join(root, artifactId);
    await fs.mkdir(directory, { mode: 0o700 });
    hostRoot = config.hostTempRoot;
  }

  const valueEndpoint = `/me/messages/${encodeURIComponent(params.message_id)}/attachments/${encodeURIComponent(params.attachment_id)}/$value`;
  const response = await graphClient.performRequest(valueEndpoint, accessToken, { method: 'GET' });
  if (!response.ok) {
    if (artifactId) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    await responseError(response, 'Attachment download');
  }

  let streamed;
  try {
    streamed = await streamAttachmentToTemporaryFile(response, directory, config.maxBytes);
    if (expectedSha256 && streamed.sha256 !== expectedSha256) {
      throw new Error(`SHA-256 mismatch: expected ${expectedSha256}, received ${streamed.sha256}`);
    }
    const inspection = inspectContent(fileName, metadata.contentType, detectMagic(streamed.prefix), metadata.size, streamed.size);
    const finalPath = path.join(directory, fileName);
    const overwritten = await publishNoClobber(streamed.tempPath, finalPath, params.overwrite === true);
    const now = new Date();
    const expiresAt = artifactId ? new Date(now.getTime() + config.tempTtlSeconds * 1000).toISOString() : undefined;
    const provenance = {
      source: 'microsoft-graph-mail-attachment',
      message_id: params.message_id,
      attachment_id: params.attachment_id,
      original_file_name: metadata.name,
      saved_file_name: fileName,
      content_type: metadata.contentType || 'application/octet-stream',
      declared_size: metadata.size,
      size: streamed.size,
      sha256: streamed.sha256,
      is_inline: metadata.isInline,
      attachment_type: 'fileAttachment',
      downloaded_at: now.toISOString(),
      mode: params.mode,
      analysis_safe: inspection.analysis_safe,
      detected_format: inspection.magic,
      warnings: inspection.warnings,
    };
    if (artifactId) {
      await writeJsonAtomic(path.join(directory, META_FILE), { artifact_id: artifactId, expires_at: expiresAt, path: finalPath, ...provenance });
    }
    return {
      artifact_id: artifactId,
      expires_at: expiresAt,
      path: finalPath,
      host_path: mapHostPath(finalPath, root, hostRoot),
      overwritten,
      ...provenance,
    };
  } catch (error) {
    if (streamed?.tempPath) await fs.unlink(streamed.tempPath).catch(() => undefined);
    if (artifactId) await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function readTempArtifact(artifactId, config) {
  if (!UUID_RE.test(artifactId)) throw new Error('artifact_id is not a valid temporary attachment id');
  const root = await ensureRoot(config.tempRoot);
  const directory = path.join(root, artifactId);
  if (!isWithin(root, directory)) throw new Error('artifact_id escapes the temporary root');
  const stats = await fs.lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error('Temporary attachment artifact is not a real directory');
  const realDirectory = await fs.realpath(directory);
  if (!isWithin(root, realDirectory)) throw new Error('Temporary attachment artifact resolves outside the temporary root');
  const metaPath = path.join(realDirectory, META_FILE);
  const metaStats = await fs.lstat(metaPath);
  if (metaStats.isSymbolicLink() || !metaStats.isFile()) throw new Error('Temporary attachment provenance is invalid');
  const metadata = JSON.parse(await fs.readFile(metaPath, 'utf8'));
  if (metadata.artifact_id !== artifactId || typeof metadata.path !== 'string') throw new Error('Temporary attachment provenance does not match artifact_id');
  const filePath = path.resolve(metadata.path);
  if (!isWithin(realDirectory, filePath) || path.dirname(filePath) !== realDirectory) throw new Error('Temporary attachment provenance contains an unsafe file path');
  return { root, directory: realDirectory, filePath, metadata };
}

async function copyAndHashSource(sourcePath, destinationDirectory, maxBytes) {
  const source = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const tempPath = path.join(destinationDirectory, `.promote-${process.pid}-${randomUUID()}.tmp`);
  let destination;
  let created = false;
  try {
    const before = await source.stat();
    if (!before.isFile()) throw new Error('Temporary attachment is not a regular file');
    if (before.size > maxBytes) throw new Error(`Temporary attachment exceeds maximum size of ${maxBytes} bytes`);
    destination = await fs.open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(IO_CHUNK_BYTES);
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await destination.write(chunk);
      position += bytesRead;
    }
    const after = await source.stat();
    if (position !== before.size || after.size !== before.size || after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) {
      throw new Error('Temporary attachment changed during promotion');
    }
    await destination.sync();
    await destination.close();
    destination = undefined;
    return { tempPath, size: position, sha256: hash.digest('hex') };
  } catch (error) {
    if (destination) await destination.close().catch(() => undefined);
    if (created) await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  } finally {
    await source.close();
  }
}

async function promoteAttachment(params, config) {
  if (!config.durableRoot) throw new Error('Durable attachment storage is disabled');
  const temp = await readTempArtifact(params.artifact_id, config);
  const durableRoot = await ensureRoot(config.durableRoot);
  const destinationDirectory = await ensureSafeSubdirectory(durableRoot, params.durable_relative_directory);
  const fileName = params.file_name ? sanitizeFileName(params.file_name) : sanitizeFileName(temp.metadata.saved_file_name);
  const copied = await copyAndHashSource(temp.filePath, destinationDirectory, config.maxBytes);
  try {
    if (copied.sha256 !== temp.metadata.sha256 || copied.size !== temp.metadata.size) {
      throw new Error('Temporary attachment integrity check failed during promotion');
    }
    const finalPath = path.join(destinationDirectory, fileName);
    const overwritten = await publishNoClobber(copied.tempPath, finalPath, params.overwrite === true);
    return {
      artifact_id: params.artifact_id,
      path: finalPath,
      host_path: mapHostPath(finalPath, durableRoot, config.hostDurableRoot),
      file_name: fileName,
      size: copied.size,
      sha256: copied.sha256,
      promoted_at: new Date().toISOString(),
      overwritten,
      source_provenance: {
        message_id: temp.metadata.message_id,
        attachment_id: temp.metadata.attachment_id,
        original_file_name: temp.metadata.original_file_name,
        content_type: temp.metadata.content_type,
        downloaded_at: temp.metadata.downloaded_at,
      },
    };
  } catch (error) {
    await fs.unlink(copied.tempPath).catch(() => undefined);
    throw error;
  }
}

async function cleanupArtifact(artifactId, config) {
  const temp = await readTempArtifact(artifactId, config);
  await fs.rm(temp.directory, { recursive: true, force: false });
  await fsyncDirectory(temp.root);
  return { artifact_id: artifactId, deleted: true };
}

export async function cleanupExpiredAttachments(config = loadAttachmentConfig(), now = Date.now()) {
  const root = await ensureRoot(config.tempRoot);
  let removed = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
    try {
      const artifact = await readTempArtifact(entry.name, config);
      const expiresAt = Date.parse(artifact.metadata.expires_at || '');
      if (Number.isFinite(expiresAt) && expiresAt <= now) {
        await fs.rm(artifact.directory, { recursive: true, force: false });
        removed += 1;
      }
    } catch {
      // Fail closed: unknown/invalid directories are never auto-deleted.
    }
  }
  if (removed > 0) await fsyncDirectory(root);
  return removed;
}

export async function startAttachmentCleanup(config = loadAttachmentConfig()) {
  await cleanupExpiredAttachments(config);
  const intervalMs = Math.min(60 * 60 * 1000, Math.max(60 * 1000, Math.floor(config.tempTtlSeconds * 500)));
  const timer = setInterval(() => {
    void cleanupExpiredAttachments(config).catch((error) => {
      console.error(`MS365 attachment cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, intervalMs);
  timer.unref();
  return timer;
}

function toolEnabled(options, name) {
  if (!options?.enabledTools) return true;
  try {
    return new RegExp(options.enabledTools, 'i').test(name);
  } catch {
    return false;
  }
}

function mailReadAllowed(options) {
  if (options?.allowedScopes === undefined) return true;
  const scopes = new Set(String(options.allowedScopes).trim().split(/\s+/).filter(Boolean));
  return scopes.has('Mail.Read') || scopes.has('Mail.ReadWrite') || scopes.has('Mail.Read.All') || scopes.has('Mail.ReadWrite.All');
}

function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(error) {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
    isError: true,
  };
}

const saveSchema = z.object({
  message_id: z.string().min(1).describe('Microsoft Graph message id.'),
  attachment_id: z.string().min(1).describe('Microsoft Graph attachment id from list-mail-attachments.'),
  mode: z.enum(['temporary', 'durable']).default('temporary').describe('temporary is disposable analysis storage; durable writes under the configured documents root.'),
  durable_relative_directory: z.string().optional().describe('Required for durable mode. Relative directory under the configured durable documents root; absolute paths and traversal are rejected.'),
  file_name: z.string().optional().describe('Optional filename override only; paths are rejected.'),
  expected_sha256: z.string().optional().describe('Optional expected SHA-256 for integrity verification.'),
  allow_inline: z.boolean().default(false).describe('Allow an inline fileAttachment. Off by default.'),
  overwrite: z.boolean().default(false).describe('Replace an existing regular file only when explicitly true. Default is no-clobber.'),
}).superRefine((value, ctx) => {
  if (value.mode === 'durable' && !value.durable_relative_directory) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['durable_relative_directory'], message: 'durable_relative_directory is required in durable mode' });
  }
  if (value.mode === 'temporary' && value.durable_relative_directory) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['durable_relative_directory'], message: 'durable_relative_directory is only valid in durable mode' });
  }
});

const promoteSchema = z.object({
  artifact_id: z.string().uuid().describe('Temporary attachment artifact id returned by save-mail-attachment.'),
  durable_relative_directory: z.string().min(1).describe('Relative directory under the configured durable documents root.'),
  file_name: z.string().optional().describe('Optional filename override only; paths are rejected.'),
  overwrite: z.boolean().default(false).describe('Replace an existing regular file only when explicitly true. Default is no-clobber.'),
});

const cleanupSchema = z.object({
  artifact_id: z.string().uuid().describe('Temporary attachment artifact id to remove.'),
});

export function registerMailAttachmentTools(server, graphClient, options = {}, config = loadAttachmentConfig()) {
  if (toolEnabled(options, 'save-mail-attachment') && mailReadAllowed(options)) {
    server.registerTool('save-mail-attachment', {
      title: 'save-mail-attachment',
      description: 'Safely download one Outlook fileAttachment via Microsoft Graph /$value directly to bounded Hypershell temporary or durable storage. Streams bytes server-side, never returns base64, enforces size/path/no-clobber controls, and returns SHA-256 plus provenance.',
      inputSchema: saveSchema,
      annotations: { title: 'save-mail-attachment', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, async (params) => {
      try { return result(await downloadAttachment(graphClient, params, config)); } catch (error) { return failure(error); }
    });
  }
  if (toolEnabled(options, 'promote-mail-attachment')) {
    server.registerTool('promote-mail-attachment', {
      title: 'promote-mail-attachment',
      description: 'Promote an existing temporary MS365 attachment artifact into the configured durable documents root after re-verifying its SHA-256 and size. The temporary artifact remains until cleanup-mail-attachment is called or TTL cleanup expires it.',
      inputSchema: promoteSchema,
      annotations: { title: 'promote-mail-attachment', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async (params) => {
      try { return result(await promoteAttachment(params, config)); } catch (error) { return failure(error); }
    });
  }
  if (toolEnabled(options, 'cleanup-mail-attachment')) {
    server.registerTool('cleanup-mail-attachment', {
      title: 'cleanup-mail-attachment',
      description: 'Delete exactly one temporary MS365 attachment artifact by its UUID after validating its provenance and containment. Durable documents are never deleted by this tool.',
      inputSchema: cleanupSchema,
      annotations: { title: 'cleanup-mail-attachment', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    }, async (params) => {
      try { return result(await cleanupArtifact(params.artifact_id, config)); } catch (error) { return failure(error); }
    });
  }
}
