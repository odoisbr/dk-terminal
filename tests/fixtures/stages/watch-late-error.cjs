// Backend sintético para provar que o teste nativo não aceita uma falha tardia
// como se fs.watch tivesse recusado a instalação.
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
fs.watch = () => {
  const watcher = new EventEmitter();
  const timer = setTimeout(() => watcher.emit('error', new Error('Falha após instalação')), 200);
  watcher.close = () => clearTimeout(timer);
  return watcher;
};
