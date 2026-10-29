// A native fullscreen transition is asynchronous on macOS. Keep the preview's
// state separate from a window that the user had already made fullscreen.
const TRANSITION_TIMEOUT_MS = 5000;

class BrowserFullscreen {
  constructor(window, changed) {
    this.window = window;
    this.changed = typeof changed === 'function' ? changed : () => {};
    this._active = false;
    this._desired = false;
    this._owned = false;
    this._disposed = false;
    this._running = false;
    this._transition = null;
    this._waiters = [];
    // On macOS isFullScreen() can change before the completion event. Track
    // the last completed native state, including changes outside this class.
    try { this._nativeConfirmed = window.isFullScreen(); } catch { this._nativeConfirmed = null; }
    this._nativePhase = null;
    this._onEnter = () => this._onNativeEnter();
    this._onLeave = () => this._onNativeLeave();
    this._onClosed = () => this._close(new Error('A janela foi fechada.'));
    window.on('enter-full-screen', this._onEnter);
    window.on('leave-full-screen', this._onLeave);
    window.on('closed', this._onClosed);
  }

  get active() { return !this._disposed && !this.window.isDestroyed() && this._active; }
  get requested() { return !this._disposed && !this.window.isDestroyed() && this._desired; }
  get needsRestore() {
    if (this._disposed || this.window.isDestroyed() || this._active || this._desired || !this._owned || this._transition) return false;
    try { return this.window.isFullScreen(); } catch { return false; }
  }

  set(enabled) {
    if (typeof enabled !== 'boolean') return Promise.reject(new TypeError('Estado de tela cheia inválido.'));
    if (this._disposed) return Promise.reject(new Error('A janela não está disponível.'));
    if (this.window.isDestroyed()) {
      const error = new Error('A janela não está disponível.');
      this._close(error);
      return Promise.reject(error);
    }
    this._desired = enabled;
    // Cancelling a wait for another owner's transition requires no native
    // action: leave that window transition alone and close the preview mode.
    if (!enabled && !this._owned && this._nativePhase) this._finishNativePhase(this._nativePhase);
    const result = new Promise((resolve, reject) => this._waiters.push({ resolve, reject }));
    this._start();
    return result;
  }

  dispose() { this._close(new Error('O controle de tela cheia foi encerrado.')); }

  _setActive(value) {
    if (this._active === value) return;
    this._active = value;
    try { this.changed(value); } catch { /* An observer must not break native cleanup. */ }
  }

  _close(error) {
    if (this._disposed) return;
    this._disposed = true;
    this._desired = false;
    this._owned = false;
    this._setActive(false);
    this._finishTransition(error);
    this._finishNativePhase(this._nativePhase, error);
    for (const waiter of this._waiters.splice(0)) waiter.reject(error);
    this.window.removeListener('enter-full-screen', this._onEnter);
    this.window.removeListener('leave-full-screen', this._onLeave);
    this.window.removeListener('closed', this._onClosed);
  }

  _nativeState() {
    if (this._disposed || this.window.isDestroyed()) throw new Error('A janela não está disponível.');
    return this.window.isFullScreen();
  }

  _finishTransition(error) {
    const transition = this._transition;
    if (!transition) return;
    this._transition = null;
    clearTimeout(transition.timer);
    if (error) transition.reject(error); else transition.resolve();
  }

  _finishNativePhase(phase, error) {
    if (!phase) return;
    if (this._nativePhase === phase) this._nativePhase = null;
    clearTimeout(phase.timer);
    if (error) phase.reject(error); else phase.resolve();
  }

  _waitForNativePhase(target) {
    return new Promise((resolve, reject) => {
      const phase = { target, resolve, reject, timer: null };
      this._nativePhase = phase;
      phase.timer = setTimeout(() => this._finishNativePhase(phase, new Error('Tempo excedido ao aguardar a tela cheia do sistema.')), TRANSITION_TIMEOUT_MS);
    });
  }

  _onNativeEnter() {
    if (this._disposed) return;
    const phase = this._nativePhase;
    const expected = this._transition?.target === true;
    try {
      const native = this._nativeState();
      // A phase wait is resolved by either completion event: an external
      // transition can be interrupted or followed immediately by another.
      if (native || phase) this._nativeConfirmed = true;
      if (expected && !native) throw new Error('Não foi possível confirmar a tela cheia.');
      if (expected) this._finishTransition();
      if (phase) this._finishNativePhase(phase);
    } catch (error) {
      if (expected) this._finishTransition(error);
      if (phase) this._finishNativePhase(phase, error);
    }
  }

  _onNativeLeave() {
    if (this._disposed) return;
    const transition = this._transition;
    const expected = transition?.target === false;
    const phase = this._nativePhase;
    try {
      const native = this._nativeState();
      if (!native || phase) this._nativeConfirmed = false;
      if (native) {
        if (expected) this._finishTransition(new Error('Não foi possível confirmar a saída da tela cheia.'));
        if (phase) this._finishNativePhase(phase);
        return;
      }
    } catch (error) {
      if (expected) this._finishTransition(error);
      if (phase) this._finishNativePhase(phase, error);
      return;
    }
    // A request waiting for an already-started external exit is newer than
    // that exit. A real exit during our own entry still interrupts it.
    const reenterAfterExit = phase?.target === false && this._desired && !transition;
    if (!expected && !reenterAfterExit) this._desired = false;
    this._owned = false;
    this._setActive(false);
    if (expected) {
      this._finishTransition();
      if (phase) this._finishNativePhase(phase);
      return;
    }
    // A native exit is authoritative, including when a user interrupts entry.
    if (transition?.target === true && this._transition === transition) this._finishTransition(new Error('A tela cheia foi interrompida.'));
    if (phase) this._finishNativePhase(phase);
  }

  _changeNative(target) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this._finishTransition(new Error('Tempo excedido ao alterar a tela cheia.')), TRANSITION_TIMEOUT_MS);
      this._transition = { target, resolve, reject, timer };
      try {
        this.window.setFullScreen(target);
        // Windows/Linux may finish synchronously. On macOS the native event is
        // required even if isFullScreen changes during the animation.
        if (process.platform !== 'darwin' && this._transition && this._nativeState() === target) { this._nativeConfirmed = target; this._finishTransition(); }
      } catch (error) { this._finishTransition(error); }
    });
  }

  _start() {
    if (this._running || this._disposed) return;
    this._running = true;
    this._reconcile().then(() => {
      this._running = false;
      if (this._disposed) return;
      // A new request can arrive after reconciliation but before this callback.
      if (this._desired !== this._active) { this._start(); return; }
      for (const waiter of this._waiters.splice(0)) waiter.resolve(this._active);
    }, error => {
      this._running = false;
      if (this._disposed) return;
      // A failed transition must not schedule an automatic retry loop. If the
      // window actually left fullscreen without an event, publish the exit.
      try {
        if (!this._nativeState()) { this._owned = false; this._setActive(false); }
      } catch { this._close(new Error('A janela não está disponível.')); return; }
      this._desired = this._active;
      for (const waiter of this._waiters.splice(0)) waiter.reject(error);
    });
  }

  async _reconcile() {
    while (!this._disposed) {
      const desired = this._desired;
      const native = this._nativeState();
      // An explicit recovery after our own timed-out entry must remain
      // possible even if no completion event arrived.
      const recoveringOwnEntry = this._owned && !this._active && !desired;
      if (process.platform === 'darwin' && (desired || this._owned) && this._nativeConfirmed !== null && native !== this._nativeConfirmed && !recoveringOwnEntry) {
        await this._waitForNativePhase(native);
        continue;
      }
      if (desired) {
        if (!native) {
          this._setActive(false);
          this._owned = true;
          await this._changeNative(true);
          if (!this._disposed && this._desired) this._setActive(true);
          continue;
        }
        this._setActive(true);
      } else {
        if (this._owned && native) {
          await this._changeNative(false);
          this._owned = false;
          this._setActive(false);
          continue;
        }
        this._owned = false;
        this._setActive(false);
      }
      if (desired === this._desired) return;
    }
  }
}

module.exports = { BrowserFullscreen };
