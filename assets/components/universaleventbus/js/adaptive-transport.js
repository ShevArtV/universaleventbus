export default class AdaptiveTransport {
  constructor(config = {}, callbacks = {}, dependencies = {}) {
    this.config = Object.assign({
      handlerPath: '/assets/components/universaleventbus/php/ssehandler.php',
      streamIdleTimeout: 30000,
      cursorPollInitial: 2000,
      cursorPollMax: 30000,
      cursorPollFactor: 2,
      cursorPollJitter: 0.2,
      streamReconnectDelay: 500,
      cursorStorageKey: 'ueb_cursor_v2',
    }, config);

    this.onEvent = callbacks.onEvent || (() => {});
    this.onReplay = callbacks.onReplay || (() => {});
    this.onStateChange = callbacks.onStateChange || (() => {});
    this.fetchFn = dependencies.fetch || window.fetch.bind(window);
    this.EventSourceClass = dependencies.EventSource || window.EventSource;
    this.document = dependencies.document || document;
    this.location = dependencies.location || window.location;
    this.storage = dependencies.storage || window.sessionStorage;
    this.setTimer = dependencies.setTimeout || window.setTimeout.bind(window);
    this.clearTimer = dependencies.clearTimeout || window.clearTimeout.bind(window);
    this.random = dependencies.random || Math.random;

    this.state = 'paused';
    this.isLeader = false;
    this.isVisible = !this.document.hidden;
    this.eventSource = null;
    this.idleTimer = null;
    this.pollTimer = null;
    this.reconnectTimer = null;
    this.pollDelay = this.toPositiveInt(this.config.cursorPollInitial, 2000);
    this.cursor = this.readCursor();
  }

  setLeader(isLeader) {
    this.isLeader = Boolean(isLeader);
    if (!this.isLeader) {
      this.pause();
      return;
    }
    if (this.isVisible) {
      this.activate();
    }
  }

  setVisible(isVisible) {
    this.isVisible = Boolean(isVisible);
    if (!this.isVisible) {
      this.pause();
      return;
    }
    if (this.isLeader) {
      this.activate();
    }
  }

  notifyActivity() {
    if (!this.isLeader || !this.isVisible) return;
    this.enterActive();
  }

  activate() {
    this.pollDelay = this.toPositiveInt(this.config.cursorPollInitial, 2000);
    this.enterActive();
  }

  enterActive() {
    if (!this.isLeader || !this.isVisible) return;
    this.clearPollTimer();
    this.setState('active_sse');
    this.openStream();
    this.scheduleIdle();
  }

  enterIdle() {
    if (!this.isLeader || !this.isVisible) return;
    this.closeStream();
    this.clearReconnectTimer();
    this.setState('idle_poll');
    this.schedulePoll(this.pollDelay);
  }

  pause() {
    this.closeStream();
    this.clearIdleTimer();
    this.clearPollTimer();
    this.clearReconnectTimer();
    this.setState('paused');
  }

  openStream() {
    if (this.eventSource || !this.isLeader || !this.isVisible || this.state !== 'active_sse') {
      return;
    }

    const source = new this.EventSourceClass(this.buildUrl('stream'));
    this.eventSource = source;
    source.onmessage = (event) => {
      const cursor = this.toPositiveInt(event.lastEventId, this.cursor);
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      this.acceptEvent(data, cursor);
      this.scheduleIdle();
    };
    source.onerror = () => {
      if (source !== this.eventSource) return;
      this.closeStream();
      if (this.isLeader && this.isVisible && this.state === 'active_sse') {
        this.scheduleReconnect();
      }
    };
    source.addEventListener('ueb-stream-end', (event) => {
      try {
        const data = JSON.parse(event.data);
        this.setCursor(data.cursor);
      } catch {
        // The next request can safely replay unacknowledged events.
      }
    });
  }

  closeStream() {
    if (!this.eventSource) return;
    this.eventSource.close();
    this.eventSource = null;
  }

  scheduleReconnect() {
    this.clearReconnectTimer();
    const delay = this.toPositiveInt(this.config.streamReconnectDelay, 500);
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.openStream();
    }, delay);
  }

  scheduleIdle() {
    this.clearIdleTimer();
    const timeout = this.toPositiveInt(this.config.streamIdleTimeout, 30000);
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null;
      this.enterIdle();
    }, timeout);
  }

  schedulePoll(delay) {
    this.clearPollTimer();
    if (!this.isLeader || !this.isVisible || this.state !== 'idle_poll') return;
    this.pollTimer = this.setTimer(() => {
      this.pollTimer = null;
      this.poll();
    }, this.withJitter(delay));
  }

  async poll() {
    if (!this.isLeader || !this.isVisible || this.state !== 'idle_poll') return;

    let hasEvents = false;
    try {
      const response = await this.fetchFn(this.buildUrl('poll'), {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`Cursor poll failed with HTTP ${response.status}`);
      }
      const result = await response.json();
      const events = Array.isArray(result.events) ? result.events : [];
      for (const event of events) {
        const cursor = this.toPositiveInt(event.cursor, this.cursor);
        this.acceptEvent(event.data, cursor);
        hasEvents = true;
      }
      this.setCursor(result.cursor);
    } catch {
      hasEvents = false;
    }

    if (hasEvents) {
      this.pollDelay = this.toPositiveInt(this.config.cursorPollInitial, 2000);
      this.enterActive();
      return;
    }

    const maxDelay = this.toPositiveInt(this.config.cursorPollMax, 30000);
    const factor = Number(this.config.cursorPollFactor) > 1 ? Number(this.config.cursorPollFactor) : 2;
    this.pollDelay = Math.min(maxDelay, Math.round(this.pollDelay * factor));
    this.schedulePoll(this.pollDelay);
  }

  /**
   * One-shot read for a follower tab. The leader may consume events published
   * while this page was rendering before this tab joins the channel, so the
   * broadcast never reaches it. Replayed events are not relayed further.
   */
  async catchUp() {
    try {
      const response = await this.fetchFn(this.buildUrl('poll'), {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) return;
      const result = await response.json();
      const events = Array.isArray(result.events) ? result.events : [];
      for (const event of events) {
        if (!event.data || typeof event.data !== 'object') continue;
        this.setCursor(event.cursor);
        this.onReplay(event.data, this.cursor);
      }
      this.setCursor(result.cursor);
    } catch {
      // Catch-up is best effort; live delivery still comes from the leader.
    }
  }

  acceptEvent(data, cursor) {
    if (!data || typeof data !== 'object') return;
    this.setCursor(cursor);
    this.onEvent(data, this.cursor);
  }

  setCursor(cursor) {
    const value = this.toPositiveInt(cursor, this.cursor);
    if (value <= this.cursor) return;
    this.cursor = value;
    try {
      this.storage.setItem(this.config.cursorStorageKey, String(value));
    } catch {
      // Storage can be unavailable in privacy modes; in-memory cursor is enough.
    }
  }

  buildUrl(mode) {
    const url = new URL(this.config.handlerPath, this.location.origin);
    url.searchParams.set('mode', mode);
    if (this.cursor > 0) {
      url.searchParams.set('cursor', String(this.cursor));
    }
    return url.toString();
  }

  readCursor() {
    try {
      return this.toPositiveInt(this.storage.getItem(this.config.cursorStorageKey), 0);
    } catch {
      return 0;
    }
  }

  withJitter(delay) {
    const jitter = Math.max(0, Math.min(0.5, Number(this.config.cursorPollJitter) || 0));
    const multiplier = 1 + ((this.random() * 2 - 1) * jitter);
    return Math.max(0, Math.round(delay * multiplier));
  }

  toPositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange(state);
  }

  clearIdleTimer() {
    if (this.idleTimer === null) return;
    this.clearTimer(this.idleTimer);
    this.idleTimer = null;
  }

  clearPollTimer() {
    if (this.pollTimer === null) return;
    this.clearTimer(this.pollTimer);
    this.pollTimer = null;
  }

  clearReconnectTimer() {
    if (this.reconnectTimer === null) return;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}
