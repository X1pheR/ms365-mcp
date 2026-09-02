import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  cleanupExpiredAttachments,
  loadAttachmentConfig,
  registerMailAttachmentTools,
  sanitizeFileName,
} from '../src/mail-attachment-tools.mjs';

function responseJson(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}
function responseBytes(value, contentType = 'application/pdf') {
  return new Response(value, { status: 200, headers: { 'content-type': contentType, 'content-length': String(value.length) } });
}
function fakeServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, config, callback) { tools.set(name, { config, callback }); },
  };
}
function parseToolResult(result) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

async function fixture() {
  const host = await fs.mkdtemp(path.join(os.tmpdir(), 'ms365-attachment-test-'));
  const tempRoot = path.join(host, 'tmp');
  const durableRoot = path.join(host, 'documents');
  await fs.mkdir(tempRoot);
  await fs.mkdir(durableRoot);
  await fs.mkdir(path.join(durableRoot, 'Case'));
  return {
    host,
    config: { tempRoot, durableRoot, hostTempRoot: tempRoot, hostDurableRoot: durableRoot, maxBytes: 1024 * 1024, tempTtlSeconds: 60 },
  };
}

function graphClientFor(bytes, metadata = {}) {
  const calls = [];
  return {
    calls,
    authManager: { async getToken() { return 'test-token-never-returned'; } },
    async performRequest(endpoint) {
      calls.push(endpoint);
      if (endpoint.endsWith('/$value')) return responseBytes(bytes, metadata.contentType || 'application/pdf');
      return responseJson({
        '@odata.type': '#microsoft.graph.fileAttachment',
        id: 'a1', name: 'document.pdf', contentType: 'application/pdf', size: bytes.length, isInline: false,
        ...metadata,
      });
    },
  };
}

test('sanitizeFileName blocks traversal and normalizes controls', () => {
  assert.throws(() => sanitizeFileName('../x.pdf'));
  assert.throws(() => sanitizeFileName('x/y.pdf'));
  assert.throws(() => sanitizeFileName('/tmp/x.pdf'));
  assert.equal(sanitizeFileName(' report\u0007.pdf '), 'report_.pdf');
});

test('runtime allowlist controls downstream tool registration', () => {
  const server = fakeServer();
  registerMailAttachmentTools(server, {}, { enabledTools: '^(save-mail-attachment)$', allowedScopes: 'Mail.Read' }, {
    tempRoot: '/tmp/none', maxBytes: 1, tempTtlSeconds: 1,
  });
  assert.deepEqual([...server.tools.keys()], ['save-mail-attachment']);
  const saveInputSchema = server.tools.get('save-mail-attachment').config.inputSchema;
  assert.equal(saveInputSchema.constructor.name, 'ZodObject');
  assert.deepEqual(
    Object.keys(saveInputSchema.shape).sort(),
    ['allow_inline', 'attachment_id', 'durable_relative_directory', 'expected_sha256', 'file_name', 'message_id', 'mode', 'overwrite'].sort(),
  );
  assert.equal(saveInputSchema.safeParse({ message_id: 'm1', attachment_id: 'a1' }).success, true);

  const blocked = fakeServer();
  registerMailAttachmentTools(blocked, {}, { enabledTools: 'save-mail-attachment', allowedScopes: 'User.Read' }, {
    tempRoot: '/tmp/none', maxBytes: 1, tempTtlSeconds: 1,
  });
  assert.equal(blocked.tools.has('save-mail-attachment'), false);
});

test('temporary save streams PDF, returns SHA/provenance, promotes, and cleans up', async () => {
  const { host, config } = await fixture();
  try {
    const bytes = Buffer.from('%PDF-1.7\nstructural attachment test\n%%EOF\n');
    const graphClient = graphClientFor(bytes);
    const server = fakeServer();
    registerMailAttachmentTools(server, graphClient, { enabledTools: 'mail-attachment', allowedScopes: 'Mail.ReadWrite' }, config);

    const saved = parseToolResult(await server.tools.get('save-mail-attachment').callback({
      message_id: 'm1', attachment_id: 'a1', mode: 'temporary', allow_inline: false, overwrite: false,
    }));
    assert.match(saved.artifact_id, /^[0-9a-f-]{36}$/i);
    assert.equal(saved.size, bytes.length);
    assert.equal(saved.detected_format, 'pdf');
    assert.equal(saved.analysis_safe, true);
    assert.equal(typeof saved.sha256, 'string');
    assert.equal(saved.sha256.length, 64);
    assert.equal('contentBytes' in saved, false);
    assert.deepEqual(await fs.readFile(saved.path), bytes);
    assert.equal((await fs.stat(path.dirname(saved.path))).mode & 0o777, 0o750);
    assert.equal((await fs.stat(saved.path)).mode & 0o777, 0o640);
    assert.equal((await fs.stat(path.join(path.dirname(saved.path), '.hypershell-attachment.json'))).mode & 0o777, 0o640);
    assert.ok(graphClient.calls.some((value) => value.endsWith('/$value')));

    const promoted = parseToolResult(await server.tools.get('promote-mail-attachment').callback({
      artifact_id: saved.artifact_id,
      durable_relative_directory: 'Case/Evidence',
      overwrite: false,
    }));
    assert.equal(promoted.sha256, saved.sha256);
    assert.deepEqual(await fs.readFile(promoted.path), bytes);
    assert.equal((await fs.stat(path.dirname(promoted.path))).mode & 0o777, 0o750);
    assert.equal((await fs.stat(promoted.path)).mode & 0o777, 0o640);

    await assert.rejects(
      fs.access(path.join(config.durableRoot, '..', 'escape.pdf')),
    );

    const cleaned = parseToolResult(await server.tools.get('cleanup-mail-attachment').callback({ artifact_id: saved.artifact_id }));
    assert.equal(cleaned.deleted, true);
    await assert.rejects(fs.access(path.dirname(saved.path)));
  } finally {
    await fs.rm(host, { recursive: true, force: true });
  }
});

test('save rejects inconsistent mode parameters before Graph access', async () => {
  const { host, config } = await fixture();
  try {
    const bytes = Buffer.from('%PDF-1.4\nX\n');
    const graphClient = graphClientFor(bytes);
    const server = fakeServer();
    registerMailAttachmentTools(server, graphClient, { enabledTools: 'save-mail-attachment', allowedScopes: 'Mail.Read' }, config);

    const missingDirectory = await server.tools.get('save-mail-attachment').callback({
      message_id: 'm1', attachment_id: 'a1', mode: 'durable', overwrite: false, allow_inline: false,
    });
    assert.equal(missingDirectory.isError, true);
    assert.match(missingDirectory.content[0].text, /durable_relative_directory is required/);
    assert.deepEqual(graphClient.calls, []);

    const directoryInTemporaryMode = await server.tools.get('save-mail-attachment').callback({
      message_id: 'm1', attachment_id: 'a1', mode: 'temporary', durable_relative_directory: 'Case/Evidence', overwrite: false, allow_inline: false,
    });
    assert.equal(directoryInTemporaryMode.isError, true);
    assert.match(directoryInTemporaryMode.content[0].text, /only valid in durable mode/);
    assert.deepEqual(graphClient.calls, []);
  } finally {
    await fs.rm(host, { recursive: true, force: true });
  }
});

test('save rejects inline, non-file attachment, oversized metadata, and no-clobber duplicates', async () => {
  const { host, config } = await fixture();
  try {
    const bytes = Buffer.from('%PDF-1.4\nX\n');
    for (const metadata of [
      { isInline: true },
      { '@odata.type': '#microsoft.graph.itemAttachment' },
      { size: config.maxBytes + 1 },
    ]) {
      const server = fakeServer();
      registerMailAttachmentTools(server, graphClientFor(bytes, metadata), { enabledTools: 'save-mail-attachment', allowedScopes: 'Mail.Read' }, config);
      const result = await server.tools.get('save-mail-attachment').callback({ message_id: 'm1', attachment_id: 'a1', mode: 'temporary', allow_inline: false, overwrite: false });
      assert.equal(result.isError, true);
    }

    const graphClient = graphClientFor(bytes);
    const server = fakeServer();
    registerMailAttachmentTools(server, graphClient, { enabledTools: 'save-mail-attachment', allowedScopes: 'Mail.Read' }, config);
    const traversal = await server.tools.get('save-mail-attachment').callback({
      message_id: 'm1', attachment_id: 'a1', mode: 'durable', durable_relative_directory: '../escape', file_name: 'escape.pdf', overwrite: false, allow_inline: false,
    });
    assert.equal(traversal.isError, true);
    assert.match(traversal.content[0].text, /unsafe path segment|relative directory/);
    const unknownOwner = await server.tools.get('save-mail-attachment').callback({
      message_id: 'm1', attachment_id: 'a1', mode: 'durable', durable_relative_directory: 'InventedOwner', file_name: 'x.pdf', overwrite: false, allow_inline: false,
    });
    assert.equal(unknownOwner.isError, true);
    assert.match(unknownOwner.content[0].text, /top-level owner does not exist/);
    const first = parseToolResult(await server.tools.get('save-mail-attachment').callback({
      message_id: 'm1', attachment_id: 'a1', mode: 'durable', durable_relative_directory: 'Case/Evidence', file_name: 'same.pdf', overwrite: false, allow_inline: false,
    }));
    assert.ok(first.path.endsWith('/Case/Evidence/same.pdf'));
    const duplicate = await server.tools.get('save-mail-attachment').callback({
      message_id: 'm1', attachment_id: 'a1', mode: 'durable', durable_relative_directory: 'Case/Evidence', file_name: 'same.pdf', overwrite: false, allow_inline: false,
    });
    assert.equal(duplicate.isError, true);
    assert.match(duplicate.content[0].text, /already exists/);
  } finally {
    await fs.rm(host, { recursive: true, force: true });
  }
});

test('actual byte limit removes partial temporary artifacts', async () => {
  const { host, config } = await fixture();
  config.maxBytes = 16;
  try {
    const bytes = Buffer.from('%PDF-1.7\nthis is deliberately larger than sixteen bytes');
    const graphClient = graphClientFor(bytes, { size: 8 });
    // Hide content-length so the stream-time limit is the deciding guard.
    graphClient.performRequest = async (endpoint) => {
      if (!endpoint.endsWith('/$value')) return responseJson({ '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', name: 'x.pdf', contentType: 'application/pdf', size: 8, isInline: false });
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/pdf' } });
    };
    const server = fakeServer();
    registerMailAttachmentTools(server, graphClient, { enabledTools: 'save-mail-attachment', allowedScopes: 'Mail.Read' }, config);
    const result = await server.tools.get('save-mail-attachment').callback({ message_id: 'm1', attachment_id: 'a1', mode: 'temporary', allow_inline: false, overwrite: false });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /exceeds maximum size/);
    assert.deepEqual(await fs.readdir(config.tempRoot), []);
  } finally {
    await fs.rm(host, { recursive: true, force: true });
  }
});

test('expired cleanup removes only valid expired artifacts', async () => {
  const { host, config } = await fixture();
  try {
    const artifactId = '123e4567-e89b-42d3-a456-426614174000';
    const dir = path.join(config.tempRoot, artifactId);
    await fs.mkdir(dir);
    const file = path.join(dir, 'x.pdf');
    await fs.writeFile(file, '%PDF-x');
    await fs.writeFile(path.join(dir, '.hypershell-attachment.json'), JSON.stringify({ artifact_id: artifactId, path: file, expires_at: '2000-01-01T00:00:00.000Z' }));
    await fs.mkdir(path.join(config.tempRoot, 'do-not-delete'));
    assert.equal(await cleanupExpiredAttachments(config, Date.now()), 1);
    await assert.rejects(fs.access(dir));
    await fs.access(path.join(config.tempRoot, 'do-not-delete'));
  } finally {
    await fs.rm(host, { recursive: true, force: true });
  }
});

test('config defaults bound size and ttl', () => {
  const config = loadAttachmentConfig({});
  assert.equal(config.maxBytes, 50 * 1024 * 1024);
  assert.equal(config.tempTtlSeconds, 24 * 60 * 60);
});
