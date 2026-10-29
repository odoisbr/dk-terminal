const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { BrowserFullscreen } = require('../electron/browser-fullscreen.cjs');

class FakeWindow extends EventEmitter {
  constructor(fullscreen = false) { super(); this.fullscreen = fullscreen; this.destroyed = false; this.calls = []; this.failure = null; }
  isDestroyed() { return this.destroyed; }
  isFullScreen() { if (this.destroyed) throw new Error('janela destruída'); return this.fullscreen; }
  setFullScreen(value) { this.calls.push(value); if (this.failure) throw this.failure; }
  finish(value) { this.fullscreen = value; this.emit(value ? 'enter-full-screen' : 'leave-full-screen'); }
  close() { this.destroyed = true; this.emit('closed'); }
}
function fixture(fullscreen = false) {
  const window = new FakeWindow(fullscreen), changes = [];
  const controller = new BrowserFullscreen(window, active => changes.push(active));
  return { window, controller, changes };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('espera eventos nativos para entrar e restaurar a janela que o controle expandiu', async t => {
  const { window, controller, changes } = fixture(); t.after(() => controller.dispose());
  const entering = controller.set(true);
  assert.deepEqual(window.calls, [true]); assert.equal(controller.active, false); assert.deepEqual(changes, []);
  window.finish(true);
  assert.equal(await entering, true); assert.equal(controller.active, true); assert.deepEqual(changes, [true]);
  const leaving = controller.set(false);
  assert.deepEqual(window.calls, [true, false]); assert.equal(controller.active, true);
  window.finish(false);
  assert.equal(await leaving, false); assert.equal(controller.active, false); assert.deepEqual(changes, [true, false]);
});

test('janela que já estava em tela cheia permanece assim após sair da prévia', async t => {
  const { window, controller, changes } = fixture(true); t.after(() => controller.dispose());
  assert.equal(controller.needsRestore, false);
  assert.equal(await controller.set(true), true); assert.equal(controller.active, true);
  assert.equal(await controller.set(false), false); assert.equal(window.fullscreen, true);
  assert.equal(controller.needsRestore, false); assert.deepEqual(window.calls, []); assert.deepEqual(changes, [true, false]);
});

test('saída pelo controle nativo desativa o modo e não reabre a janela', async t => {
  const { window, controller, changes } = fixture(); t.after(() => controller.dispose());
  const entering = controller.set(true); window.finish(true); await entering;
  window.finish(false); await tick();
  assert.equal(controller.active, false); assert.deepEqual(changes, [true, false]);
  assert.equal(await controller.set(false), false); assert.deepEqual(window.calls, [true]);
});

test('entrada e saída rápidas são serializadas até restaurar, sem ativação transitória', async t => {
  const { window, controller, changes } = fixture(); t.after(() => controller.dispose());
  const entering = controller.set(true);
  assert.equal(controller.active, false); assert.equal(controller.requested, true);
  const leaving = controller.set(false);
  assert.equal(controller.requested, false);
  assert.deepEqual(window.calls, [true]); window.finish(true); await tick();
  assert.deepEqual(window.calls, [true, false]); assert.equal(controller.active, false);
  window.finish(false);
  assert.deepEqual(await Promise.all([entering, leaving]), [false, false]);
  assert.deepEqual(changes, []); assert.equal(window.fullscreen, false); assert.equal(controller.requested, false);
});

test('pedidos rápidos usam o último estado sem criar transições duplicadas', async t => {
  const { window, controller, changes } = fixture(); t.after(() => controller.dispose());
  const first = controller.set(true), second = controller.set(false), third = controller.set(true);
  assert.deepEqual(window.calls, [true]); window.finish(true);
  assert.deepEqual(await Promise.all([first, second, third]), [true, true, true]);
  assert.deepEqual(changes, [true]); assert.equal(controller.active, true);
});

test('reentrada durante a saída espera o evento antes de expandir novamente', async t => {
  const { window, controller, changes } = fixture(); t.after(() => controller.dispose());
  const entering = controller.set(true); window.finish(true); await entering;
  const leaving = controller.set(false), reentering = controller.set(true);
  assert.deepEqual(window.calls, [true, false]); window.finish(false); await tick();
  assert.deepEqual(window.calls, [true, false, true]); assert.equal(controller.active, false);
  window.finish(true);
  assert.deepEqual(await Promise.all([leaving, reentering]), [true, true]);
  assert.deepEqual(changes, [true, false, true]);
});

test('evento de entrada sem estado confirmado reprova e não tenta novamente', async t => {
  const { window, controller, changes } = fixture(); t.after(() => controller.dispose());
  const promise = controller.set(true);
  window.emit('enter-full-screen');
  await assert.rejects(promise, /confirmar a tela cheia/);
  assert.equal(controller.active, false); assert.deepEqual(changes, []); assert.deepEqual(window.calls, [true]);
});

test('evento de saída incoerente não informa que a prévia deixou tela cheia', async t => {
  const { window, controller, changes } = fixture(); t.after(() => controller.dispose());
  const entering = controller.set(true); window.finish(true); await entering;
  const leaving = controller.set(false), rejected = assert.rejects(leaving, /confirmar a saída/);
  window.emit('leave-full-screen'); await rejected;
  assert.equal(controller.active, true); assert.equal(controller.requested, true);
  assert.equal(window.fullscreen, true); assert.deepEqual(changes, [true]);
  assert.deepEqual(window.calls, [true, false]);
});

test('evento de saída atrasado após reentrada não cancela a prévia ainda ativa', async t => {
  const { window, controller, changes } = fixture(); t.after(() => controller.dispose());
  const entering = controller.set(true); window.finish(true); await entering;
  window.emit('leave-full-screen'); await tick();
  assert.equal(controller.active, true); assert.equal(controller.requested, true);
  assert.deepEqual(changes, [true]); assert.deepEqual(window.calls, [true]);
});

test('falha ao chamar o sistema rejeita sem anunciar tela cheia e permite nova tentativa', async t => {
  const { window, controller, changes } = fixture(); t.after(() => controller.dispose());
  window.failure = new Error('falha do sistema');
  await assert.rejects(controller.set(true), /falha do sistema/);
  assert.equal(controller.active, false); assert.deepEqual(changes, []); assert.deepEqual(window.calls, [true]);
  window.failure = null;
  const next = controller.set(true); window.finish(true);
  assert.equal(await next, true); assert.deepEqual(window.calls, [true, true]);
});

test('timeout de entrada não altera o estado nem repete a solicitação', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { window, controller, changes } = fixture(); t.after(() => controller.dispose());
  const promise = controller.set(true), rejected = assert.rejects(promise, /Tempo excedido/);
  t.mock.timers.tick(5000); await rejected;
  assert.equal(controller.active, false); assert.deepEqual(changes, []); assert.deepEqual(window.calls, [true]);
  window.finish(true); await Promise.resolve();
  assert.equal(controller.active, false); assert.deepEqual(window.calls, [true]);
});

test('timeout com flag nativa ativa expõe restauração explícita sem confirmar entrada', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { window, controller, changes } = fixture(); t.after(() => controller.dispose());
  const entering = controller.set(true), rejected = assert.rejects(entering, /Tempo excedido/);
  window.fullscreen = true; // A flag mudou, mas nenhum evento confirmou a entrada.
  assert.equal(controller.needsRestore, false);
  t.mock.timers.tick(5000); await rejected;
  assert.equal(controller.active, false); assert.equal(controller.requested, false); assert.equal(controller.needsRestore, true);
  assert.deepEqual(window.calls, [true]); assert.deepEqual(changes, []);
  // A integração pode usar active || requested || needsRestore para o Escape.
  assert.ok(controller.active || controller.requested || controller.needsRestore);
  const restoring = controller.set(false);
  assert.deepEqual(window.calls, [true, false]); assert.equal(controller.needsRestore, false);
  window.finish(false);
  assert.equal(await restoring, false); assert.equal(controller.needsRestore, false);
  assert.equal(window.fullscreen, false); assert.deepEqual(changes, []);
});

test('cancelamento rápido seguido de timeout permite restaurar com nova ação explícita', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { window, controller, changes } = fixture(); t.after(() => controller.dispose());
  const entering = controller.set(true); window.fullscreen = true;
  const cancelled = controller.set(false), pending = Promise.allSettled([entering, cancelled]);
  assert.equal(controller.needsRestore, false);
  t.mock.timers.tick(5000);
  const results = await pending;
  assert.ok(results.every(result => result.status === 'rejected'));
  assert.equal(controller.active, false); assert.equal(controller.requested, false); assert.equal(controller.needsRestore, true);
  assert.deepEqual(window.calls, [true]); assert.deepEqual(changes, []);
  const restoring = controller.set(false); window.finish(false);
  assert.equal(await restoring, false); assert.equal(controller.needsRestore, false);
  assert.deepEqual(window.calls, [true, false]);
});

test('falha da restauração mantém a opção de nova tentativa, sem laço automático', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { window, controller, changes } = fixture(); t.after(() => controller.dispose());
  const entering = controller.set(true), entryFailed = assert.rejects(entering, /Tempo excedido/);
  window.fullscreen = true; t.mock.timers.tick(5000); await entryFailed;
  assert.equal(controller.needsRestore, true);
  const restoring = controller.set(false), restoreFailed = assert.rejects(restoring, /Tempo excedido/);
  t.mock.timers.tick(5000); await restoreFailed;
  assert.equal(controller.active, false); assert.equal(controller.needsRestore, true);
  assert.deepEqual(window.calls, [true, false]); assert.deepEqual(changes, []);
  window.finish(false); // O usuário saiu pelos controles nativos.
  assert.equal(controller.needsRestore, false); assert.deepEqual(window.calls, [true, false]);
});

test('timeout de saída mantém o estado ativo enquanto a janela ainda estiver em tela cheia', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { window, controller, changes } = fixture(); t.after(() => controller.dispose());
  const entering = controller.set(true); window.finish(true); await entering;
  const leaving = controller.set(false), rejected = assert.rejects(leaving, /Tempo excedido/);
  t.mock.timers.tick(5000); await rejected;
  assert.equal(controller.active, true); assert.deepEqual(changes, [true]); assert.deepEqual(window.calls, [true, false]);
  window.finish(false); await Promise.resolve();
  assert.equal(controller.active, false); assert.deepEqual(changes, [true, false]); assert.deepEqual(window.calls, [true, false]);
});

test('fechar a janela rejeita transição pendente e remove os listeners', async () => {
  const { window, controller, changes } = fixture();
  const entering = controller.set(true), rejected = assert.rejects(entering, /janela foi fechada/i);
  window.close(); await rejected;
  assert.equal(controller.active, false); assert.deepEqual(changes, []);
  for (const name of ['enter-full-screen', 'leave-full-screen', 'closed']) assert.equal(window.listenerCount(name), 0);
  await assert.rejects(controller.set(true), /não está disponível/);
});

test('janela destruída sem evento não mantém estado ativo nem pedido pendente', async () => {
  const { window, controller, changes } = fixture();
  const entering = controller.set(true); window.finish(true); await entering;
  const leaving = controller.set(false), rejected = assert.rejects(leaving, /janela não está disponível/);
  window.destroyed = true;
  assert.equal(controller.active, false); assert.equal(controller.requested, false);
  await assert.rejects(controller.set(false), /janela não está disponível/); await rejected;
  assert.deepEqual(changes, [true, false]);
  for (const name of ['enter-full-screen', 'leave-full-screen', 'closed']) assert.equal(window.listenerCount(name), 0);
});

test('transições síncronas sem evento em Windows/Linux seguem o estado da janela', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
  for (const platform of ['win32', 'linux']) {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
    const { window, controller, changes } = fixture();
    window.setFullScreen = function(value) { this.calls.push(value); this.fullscreen = value; };
    assert.equal(await controller.set(true), true); assert.equal(controller.active, true);
    assert.equal(await controller.set(false), false); assert.equal(controller.active, false);
    assert.deepEqual(window.calls, [true, false]); assert.deepEqual(changes, [true, false]);
    controller.dispose();
  }
});

test('dispose cancela operações, remove os listeners e não altera a janela preexistente', async () => {
  const { window, controller } = fixture();
  const entering = controller.set(true), rejected = assert.rejects(entering, /controle de tela cheia foi encerrado/);
  controller.dispose(); await rejected; controller.dispose();
  assert.equal(controller.active, false); assert.deepEqual(window.calls, [true]);
  for (const name of ['enter-full-screen', 'leave-full-screen', 'closed']) assert.equal(window.listenerCount(name), 0);
  window.finish(true); assert.equal(controller.active, false);
  await assert.rejects(controller.set(false), /não está disponível/);
});

test('saída nativa durante entrada interrompe a operação pendente', async t => {
  const { window, controller, changes } = fixture(); t.after(() => controller.dispose());
  const entering = controller.set(true), rejected = assert.rejects(entering, /interrompida/);
  window.finish(false); await rejected;
  assert.equal(controller.active, false); assert.deepEqual(changes, []); assert.deepEqual(window.calls, [true]);
});

test('mudança solicitada pelo observador durante a notificação não é perdida', async t => {
  const window = new FakeWindow(true), changes = []; let second;
  const controller = new BrowserFullscreen(window, active => { changes.push(active); if (active) second = controller.set(false); });
  t.after(() => controller.dispose());
  const first = controller.set(true);
  assert.deepEqual(await Promise.all([first, second]), [false, false]);
  assert.equal(controller.active, false); assert.deepEqual(changes, [true, false]); assert.deepEqual(window.calls, []);
});

test('observador pode pedir nova entrada durante a notificação de saída nativa', async t => {
  const window = new FakeWindow(), changes = []; let next;
  const controller = new BrowserFullscreen(window, active => {
    changes.push(active);
    if (!active && changes.length === 2) next = controller.set(true);
  });
  t.after(() => controller.dispose());
  const first = controller.set(true); window.finish(true); await first;
  window.finish(false);
  assert.deepEqual(window.calls, [true, true]);
  window.finish(true);
  assert.equal(await next, true); assert.equal(controller.active, true); assert.deepEqual(changes, [true, false, true]);
});

test('valida tipo de entrada sem mudar o estado da janela', async t => {
  const { window, controller } = fixture(); t.after(() => controller.dispose());
  await assert.rejects(controller.set('sim'), /Estado de tela cheia inválido/);
  assert.deepEqual(window.calls, []); assert.equal(controller.active, false);
});
