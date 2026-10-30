'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const patch = require('./html-patch.cjs');
const { resolveFile, readBounded } = require('./files.cjs');

// One document per worker. Edits never cross the message boundary: applyEdit
// receives only apply()/invert() output belonging to this worker's document.
let doc, undo = [], redo = [], truncated = false;
const HISTORY_ENTRIES = 200, HISTORY_BYTES = 8 * 1024 * 1024;
const sizeOf = edit => 16 + Buffer.byteLength(edit.oldText) + Buffer.byteLength(edit.newText);
const failure = reason => ({ ok: false, reason, message: reason });

function assetExists(relative) {
  const stat = fs.lstatSync(workerData.root);
  if (!stat.isDirectory() || stat.dev !== workerData.dev || stat.ino !== workerData.ino) return null;
  const file = resolveFile(workerData.root, relative);
  file.absolute = fs.realpathSync.native(file.absolute);
  const actual = path.relative(workerData.root, file.absolute).split(path.sep).join('/');
  if (actual.split('/').some(p => p.normalize('NFKC').startsWith('.') || p.toLowerCase() === 'node_modules') ||
      !/\.(png|jpe?g|gif|webp|svg)$/i.test(actual)) return null;
  if (file.stat.size > patch.LIMITS.image) return { ok: true, size: file.stat.size };
  const bytes = readBounded(file, patch.LIMITS.image);
  return bytes && { ok: true, size: bytes.length };
}

function snapshot(next, serving) {
  const served = patch.serve(next, serving);
  const hash = createHash('sha256').update(patch.encode(next)).digest('hex');
  const { warnings, scripts, handlers, eol, loneCR } = next;
  return { served, hash, info: { nodes: next.nodes.length, warnings, scripts, handlers, eol, loneCR } };
}
function history() { return { canUndo: !!undo.length, canRedo: !!redo.length, truncated }; }

function dispatch(message) {
  const { command } = message;
  if (command === 'prepare') {
    const result = patch.prepare(Buffer.from(message.bytes), { relative: message.relative });
    if (!result.ok) return result;
    const view = snapshot(result.doc, message.serving);
    const reply = { ok: true, ...view, history: { canUndo: false, canRedo: false, truncated: false } };
    doc = result.doc; undo = []; redo = []; truncated = false;
    return reply;
  }
  if (!doc) return failure('not-open');
  if (command === 'inspect') {
    if (!Number.isSafeInteger(message.node)) return failure('no-target');
    const node = doc.nodes.find(n => n.id === message.node);
    if (!node) return failure('no-target');
    return { ok: true, inspect: { ...patch.inspect(doc, message.node), readonly: node.readonly } };
  }
  if (command === 'encode') return { ok: true, bytes: patch.encode(doc) };
  if (command === 'serve') return { ok: true, ...snapshot(doc, message.serving), history: history() };
  let next, inverse;
  if (command === 'apply') {
    const op = message.op;
    const keys = { text: 'node,type,value', attr: 'name,node,type,value', css: 'node,prop,type,value' };
    if (!op || !Object.hasOwn(keys, op.type) || Object.keys(op).sort().join(',') !== keys[op.type] ||
        !Number.isSafeInteger(op.node)) return failure('value-invalid');
    const result = patch.apply(doc, op, { assetExists });
    if (!result.ok) return result;
    next = result.doc; inverse = patch.invert(result.edit);
  } else if (command === 'undo' || command === 'redo') {
    const entry = (command === 'undo' ? undo : redo).at(-1);
    if (!entry) return failure('no-target');
    next = patch.applyEdit(doc, entry);
    inverse = patch.invert(entry);
  } else return failure('value-invalid');

  // Prepare every fallible operation (including inverse sizes and reply)
  // before committing either document or history.
  const view = snapshot(next, message.serving);
  const nextUndo = undo.slice(), nextRedo = command === 'apply' ? [] : redo.slice();
  let nextTruncated = truncated;
  if (command === 'apply') {
    nextUndo.push(inverse);
  } else if (command === 'undo') { nextUndo.pop(); nextRedo.push(inverse); }
  else { nextRedo.pop(); nextUndo.push(inverse); }
  let bytes = [...nextUndo, ...nextRedo].reduce((sum, entry) => sum + sizeOf(entry), 0);
  if (command === 'apply') {
    while (nextUndo.length > HISTORY_ENTRIES || bytes > HISTORY_BYTES) {
      bytes -= sizeOf(nextUndo.shift()); nextTruncated = true;
    }
  }
  const reply = { ok: true, ...view, history: { canUndo: !!nextUndo.length, canRedo: !!nextRedo.length, truncated: nextTruncated } };
  doc = next; undo = nextUndo; redo = nextRedo; truncated = nextTruncated;
  return reply;
}

parentPort.on('message', message => {
  let result;
  try { result = dispatch(message); }
  catch (error) { result = failure(error.reason || (error.code ? 'file-unavailable' : 'value-invalid')); }
  parentPort.postMessage({ id: message.id, result });
});
