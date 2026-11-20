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
    // poll-only: no SSE at all, delivery only by cursor polling.
    this.pollOnly = this.config.transport === 'poll';
    this.polling = false;
    // lazy start: no stream and no polling loop until the first user action;
    // before it the page gets one cursor read (pollOnce) with its render events.
    this.lazyStart = this.config.transportStart === 'lazy';
    this.armed = !this.lazyStart;
    this.pollOncePromise = null;
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
    const wasArmed = this.armed;
    this.armed = true;
    if (!this.isLeader || !this.isVisible) return;
    if (!wasArmed && this.pollOncePromise) {
      // The stream opens after the one-shot read finishes: same cursor, no duplicates.
      this.pollOncePromise.then(() => this.enterActive());
      return;
    }
    this.enterActive();
  }

  activate() {
    this.pollDelay = this.toPositiveInt(this.config.cursorPollInitial, 2000);
    if (!this.armed) {
      this.enterLazyWait();
      return;
    }
    this.enterActive();
  }

  // Lazy start before the first user action: one read, no stream, no timers.
  enterLazyWait() {
    if (!this.isLeader || !this.isVisible) return;
    this.setState('lazy_wait');
    this.pollOnce();
  }

  async pollOnce() {
    if (this.pollOncePromise || this.polling) return;
    this.polling = true;
    this.pollOncePromise = this.readCursorEvents().finally(() => {
      this.polling = false;
      this.pollOncePromise = null;
    });
    await this.pollOncePromise;
  }

  enterActive() {
    if (!this.isLeader || !this.isVisible) return;
    if (this.pollOnly) {
      this.enterActivePoll();
      return;
    }
    this.clearPollTimer();
    this.setState('active_sse');
    this.openStream();
    this.scheduleIdle();
  }

  // poll-only activity window: no stream, constant short pause between polls.
  // Only entering the window polls immediately; further activity just extends it.
  enterActivePoll() {
    const entering = this.state !== 'active_poll';
    this.setState('active_poll');
    this.scheduleIdle();
    if (!entering) return;
    this.pollDelay = this.toPositiveInt(this.config.cursorPollInitial, 2000);
    this.clearPollTimer();
    this.poll();
  }

  enterIdle() {
    if (!this.isLeader || !this.isVisible) return;
    this.closeStream();
    this.clearReconnectTimer();
    this.setState('idle_poll');
    if (this.pollOnly && (this.pollTimer !== null || this.polling)) {
      // The poll planned inside the window stays as is; the pause starts
      // growing from the first empty poll after the window.
      return;
    }
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
    if (this.pollOnly || this.eventSource || !this.isLeader || !this.isVisible || this.state !== 'active_sse') {
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
    if (!this.isLeader || !this.isVisible || !this.canPoll()) return;
    this.pollTimer = this.setTimer(() => {
      this.pollTimer = null;
      this.poll();
    }, this.withJitter(delay));
  }

  canPoll() {
    return this.state === 'idle_poll' || (this.pollOnly && this.state === 'active_poll');
  }

  async poll() {
    if (!this.isLeader || !this.isVisible || !this.canPoll() || this.polling) return;

    this.polling = true;
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
      hasEvents = this.acceptPollResult(await response.json());
    } catch {
      hasEvents = false;
    } finally {
      this.polling = false;
    }

    const initial = this.toPositiveInt(this.config.cursorPollInitial, 2000);
    if (hasEvents) {
      this.pollDelay = initial;
      if (this.pollOnly) {
        if (this.isLeader && this.isVisible) {
          this.setState('active_poll');
          this.scheduleIdle();
        }
        this.schedulePoll(initial);
        return;
      }
      this.enterActive();
      return;
    }
    // State at the moment of the answer decides: inside the window the pause
    // does not grow.
    if (this.pollOnly && this.state === 'active_poll') {
      this.schedulePoll(initial);
      return;
    }

    const maxDelay = this.toPositiveInt(this.config.cursorPollMax, 30000);
    const factor = Number(this.config.cursorPollFactor) > 1 ? Number(this.config.cursorPollFactor) : 2;
    this.pollDelay = Math.min(maxDelay, Math.round(this.pollDelay * factor));
    this.schedulePoll(this.pollDelay);
  }

  // Hands the events of a cursor answer to the page. true if there were any.
  acceptPollResult(result) {
    const events = Array.isArray(result.events) ? result.events : [];
    let hasEvents = false;
    for (const event of events) {
      const cursor = this.toPositiveInt(event.cursor, this.cursor);
      this.acceptEvent(event.data, cursor);
      hasEvents = true;
    }
    this.setCursor(result.cursor);
    return hasEvents;
  }

  async readCursorEvents() {
    try {
      const response = await this.fetchFn(this.buildUrl('poll'), {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) return false;
      return this.acceptPollResult(await response.json());
    } catch {
      return false;
    }
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

  /**
   * A new tab starts at the stream position before its page was rendered, not
   * at the start of the stream: older events belong to other tabs. A tab keeps
   * its cursor across its pages, but not past the start of the new page: the
   * previous page may still read the stream while the next one renders and
   * take the new page's render events.
   */
  readCursor() {
    const stored = this.readStoredCursor();
    const start = this.toPositiveInt(this.config.startCursor, 0);
    if (!start) return stored;
    return stored ? Math.min(stored, start) : start;
  }

  /**
   * A page restored from bfcache resumes after the pages that ran in this tab meanwhile.
   */
  resumeStoredCursor() {
    this.setCursor(this.readStoredCursor());
  }

  readStoredCursor() {
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
