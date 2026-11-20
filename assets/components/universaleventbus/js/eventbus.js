// Child modules are requested with the same ?v= as this file: a CDN or browser
// cache keys by the full URL, so after a package update an old module cannot be
// served to the new bus.
const version = new URL(import.meta.url).search;
let UebBroadcastChannel;
let AdaptiveTransport;

class EventBus {
  constructor() {
    if (window.EventBus) return window.EventBus;
    this.config = {
      eventAttr: 'data-ueb-event',
      eventKey: 'uebEvent',
      dispatchEvent: 'eventbus',
      replayEvent: 'eventbus:replay',
      beforeSendEvent: 'eventbus:before:send',
      onceKey: 'uebOnce',
      paramsKey: 'uebParams',
      navigationTimeout: 1200,
      expiredMessageId: 100000,
      intersectionObserverOptions: {
        threshold: 0.2,
        rootMargin: '0px',
      }
    };
    this.config = Object.assign(this.config, window.uebConfig);
    window.EventBus = this;
    this.receivedEventIds = new Map();
    this.transport = null;
    // lazy: adaptive-transport.js is loaded after the page load (or at the first user
    // action); what the bus is told before that (leader, visibility, catch-up) waits here.
    this.lazyTransport = this.config.transport !== 'legacy' && this.config.transportStart === 'lazy';
    this.pending = {leader: false, visible: !document.hidden, catchUp: false};
    if (this.config.transport !== 'legacy' && !this.lazyTransport) {
      this.transport = this.createTransport();
    }
    this.broadcastChannel = new UebBroadcastChannel(this);
    this.initialize();
    if (this.lazyTransport) {
      this.scheduleTransportLoad();
    }
  }

  createTransport() {
    return new AdaptiveTransport(this.config, {
      onEvent: (data, cursor) => this.receiveTransportEvent(data, cursor, true),
      onReplay: (data, cursor) => this.receiveTransportEvent(data, cursor, false, true),
    });
  }

  scheduleTransportLoad() {
    const run = () => {
      if ('requestIdleCallback' in window) {
        window.requestIdleCallback(() => this.loadTransport(), {timeout: 2000});
      } else {
        window.setTimeout(() => this.loadTransport(), 1000);
      }
    };
    if (document.readyState === 'complete') {
      run();
    } else {
      window.addEventListener('load', run, {once: true});
    }
  }

  // Lazy, before the first gesture: server answers to page events (show) are read by one
  // cursor request; several events in a row share it.
  scheduleRead() {
    window.clearTimeout(this.readTimer);
    this.readTimer = window.setTimeout(() => {
      if (this.transport) {
        this.transport.readOnce().then();
      } else {
        this.pending.read = true;
      }
    }, 300);
  }

  // Loads the transport module once and applies what was told to the bus meanwhile.
  loadTransport() {
    if (!this.transportLoading) {
      this.transportLoading = import(`./adaptive-transport.js${version}`).then((module) => {
        AdaptiveTransport = module.default;
        this.closeLegacyEventSource();
        this.transport = this.createTransport();
        this.transport.setVisible(this.pending.visible);
        this.transport.setLeader(this.pending.leader);
        if (this.pending.catchUp) {
          this.transport.catchUp().then();
        }
        if (this.pending.read) {
          this.transport.readOnce().then();
        }
        if (this.pending.activity) {
          this.transport.notifyActivity();
        }
      }).catch((error) => {
        this.transportLoading = null;
        console.error('[UniversalEventBus] the transport did not load', error);
      });
    }
    return this.transportLoading;
  }

  initialize() {
    const eventTargets = document.querySelectorAll(`[${this.config.eventAttr}]`);
    if (eventTargets.length) {
      this.initializeIntersectionObserver();
      this.initializeMutationObserver();
      this.addObservers(eventTargets);
    }
    this.addActivityListeners();
    window.addEventListener('pageshow', (e) => {
      if (e.persisted && this.transport) {
        this.transport.resumeStoredCursor();
      }
    });
  }

  setTransportLeader(isLeader) {
    this.pending.leader = Boolean(isLeader);
    if (this.transport) {
      this.transport.setLeader(isLeader);
      return;
    }
    // lazy: the transport is not loaded yet, the leader flag waits in this.pending and is
    // applied by loadTransport(); the legacy EventSource must not open here.
    if (this.lazyTransport) return;
    if (isLeader && !document.hidden) {
      this.initializeLegacyEventSource();
    } else {
      this.closeLegacyEventSource();
    }
  }

  setTransportVisible(isVisible) {
    this.pending.visible = Boolean(isVisible);
    if (this.transport) {
      this.transport.setVisible(isVisible);
      return;
    }
    if (!isVisible) {
      this.closeLegacyEventSource();
    }
  }

  catchUp() {
    if (this.transport) {
      this.transport.catchUp().then();
    } else if (this.lazyTransport) {
      this.pending.catchUp = true;
    }
  }

  initializeLegacyEventSource() {
    if (document.hidden || this.eventSource) return;
    this.eventSource = new EventSource(this.config.handlerPath + '?mode=legacy');

    this.eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data) {
        this.receiveTransportEvent(data, e.lastEventId, true);
        setTimeout(() => this.saveMessageId(e.lastEventId), 100);
      }
    };
  }

  closeLegacyEventSource() {
    if (!this.eventSource) return;
    this.eventSource.close();
    this.eventSource = null;
  }

  receiveTransportEvent(data, cursor, broadcast = false, replay = false) {
    if (!data || typeof data !== 'object') return;
    const eventId = data.eventId ? String(data.eventId) : '';
    if (eventId && this.receivedEventIds.has(eventId)) return;

    const relayed = !broadcast && !replay;
    // A relayed event is already read: a follower that later takes the lead
    // must not read it again from its own, older cursor.
    if (relayed && this.transport && this.broadcastChannel && this.broadcastChannel.caughtUp) {
      this.transport.setCursor(cursor);
    }

    // A replayed event is not remembered: the live copy from the leader must
    // still reach regular listeners.
    if (eventId && !replay) {
      this.receivedEventIds.set(eventId, Date.now());
      this.pruneReceivedEventIds();
    }
    // Replayed events go under a separate name: existing listeners must not
    // react twice to cart/order events another tab has already handled.
    document.dispatchEvent(new CustomEvent(replay ? this.config.replayEvent : this.config.dispatchEvent, {
      bubbles: false,
      cancelable: false,
      detail: {
        data: data,
        lastEventId: String(cursor || ''),
        own: this.isOwnEvent(data, broadcast),
      }
    }));
    if (broadcast && this.broadcastChannel) {
      this.broadcastChannel.broadcastEvent(data, cursor);
    }
  }

  /**
   * Whether the event belongs to this tab. Page render events carry the id of
   * the page they were rendered for, events sent from a page carry the key of
   * its tab. Other events (AJAX of other components) are caused by the user,
   * and the tab where the user acts leads the bus, so they belong to the tab
   * that read them from its own transport.
   */
  isOwnEvent(data, fromOwnTransport) {
    if (data.pageId) {
      return data.pageId === this.config.pageId;
    }
    if (data.tabKey) {
      return Boolean(this.broadcastChannel) && data.tabKey === this.broadcastChannel.tabKey;
    }
    return fromOwnTransport;
  }

  pruneReceivedEventIds() {
    const expires = Number(this.config.expiredMessageId) || 100000;
    const now = Date.now();
    for (const [eventId, createdAt] of this.receivedEventIds.entries()) {
      if (now - createdAt > expires) {
        this.receivedEventIds.delete(eventId);
      }
    }
  }

  addActivityListeners() {
    const activity = () => this.notifyActivity();
    document.addEventListener('pointerdown', activity, {passive: true});
    document.addEventListener('keydown', activity, {passive: true});
    window.addEventListener('focus', activity, {passive: true});
  }

  initializeIntersectionObserver() {
    this.intersectionObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const target = entry.target;
        if (target.hasAttribute(this.config.eventAttr)) {
          if (entry.isIntersecting && target.dataset[this.config.eventKey] === 'show') {
            this.sendHideShowEvent(target, 'hide');
          }
          if (!entry.isIntersecting && target.dataset[this.config.eventKey] === 'hide') {
            this.sendHideShowEvent(target, 'show');
          }
        }
      });
    }, this.config.intersectionObserverOptions);
  }

  initializeMutationObserver() {
    this.mutationObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class' && mutation.target.hasAttribute(this.config.eventAttr)) {
          const target = mutation.target;

          if (this.checkClasses(target, this.config.openClasses) ||
            this.checkClasses(target, this.config.closeClasses)) {
            this.sendEvent(mutation.target).then();
          }
        }
      });
    });
  }

  addObservers(eventTargets) {
    eventTargets.forEach((target) => {
      const eventName = target.dataset[this.config.eventKey];
      switch (eventName) {
      case 'show':
      case 'hide':
        this.intersectionObserver.observe(target);
        break;
      case 'open':
      case 'close':
        this.mutationObserver.observe(target, {
          attributes: true,
          attributeFilter: ['class'],
        });
        break;
      default:
        target.addEventListener(eventName, (event) => {
          if (this.deferNavigation(event, target)) {
            return;
          }
          this.sendEvent(target).then();
        });
        break;
      }
    });
  }

  deferNavigation(event, target) {
    if (event.type !== 'click'
      || event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey) {
      return false;
    }

    const link = target.closest ? target.closest('a[href]') : null;
    if (!link
      || link.hasAttribute('download')
      || (link.target && link.target.toLowerCase() !== '_self')) {
      return false;
    }

    let destination;
    try {
      destination = new URL(link.href, window.location.href);
    } catch {
      return false;
    }
    if (!['http:', 'https:'].includes(destination.protocol)) {
      return false;
    }

    const current = new URL(window.location.href);
    if (destination.origin === current.origin
      && destination.pathname === current.pathname
      && destination.search === current.search
      && destination.hash !== current.hash) {
      return false;
    }

    event.preventDefault();
    // Do not let the current page consume and persist the new cursor between
    // action.php accepting the event and the navigation being committed. The
    // next page will resume from the previous cursor and receive the event.
    this.setTransportVisible(false);
    let navigated = false;
    const navigate = () => {
      if (navigated) return;
      navigated = true;
      window.location.assign(destination.href);
    };
    const timeout = Math.max(100, Number(this.config.navigationTimeout) || 1200);
    const timer = window.setTimeout(navigate, timeout);

    this.sendEvent(target, {keepalive: true}).then(() => {
      window.clearTimeout(timer);
      navigate();
    }, () => {
      window.clearTimeout(timer);
      navigate();
    });

    return true;
  }

  saveMessageId(messageId) {
    let cookie = this.getCookie('ueb_message_ids');
    cookie = cookie ? JSON.parse(cookie) : {};
    for (let id in cookie) {
      if (Date.now() - cookie[id] > this.config.expiredMessageId) {
        delete cookie[id];
      }
    }
    if (cookie[messageId]) return;
    cookie[messageId] = Date.now();
    this.setCookie('ueb_message_ids', JSON.stringify(cookie));
  }

  sendHideShowEvent(target, type = 'show') {
    if (!target) return;
    this.sendEvent(target, {}, true).then(() => {
      (target.dataset[this.config.onceKey] !== '1') && target.setAttribute(this.config.eventAttr, type);
    });
  }

  checkClasses(target, classes) {
    if (!classes.length) return false;
    for (let i = 0; i < classes.length; i++) {
      if (target.closest(`${classes[i]}`)) {
        return true;
      }
    }
    return false;
  }

  notifyActivity() {
    this.gestured = true;
    if (this.broadcastChannel) {
      this.broadcastChannel.takeLead();
    }
    if (this.transport) {
      this.transport.notifyActivity();
    } else if (this.lazyTransport) {
      this.pending.activity = true;
      this.loadTransport();
    }
  }

  // passive: sent by the page itself (show/hide by IntersectionObserver), not by the user.
  // In lazy mode before the first user gesture it must not wake the stream: the answer is
  // read by one cursor request (see scheduleRead).
  async sendEvent(target, paramsObj = {}, passive = false) {
    const deferRead = passive && this.lazyTransport && !this.gestured;
    if (!deferRead) {
      this.notifyActivity();
    }
    if (this.broadcastChannel) {
      paramsObj.uebTabKey = this.broadcastChannel.tabKey;
    }
    const forceKeepalive = paramsObj.keepalive === true;
    paramsObj.eventName = paramsObj.eventName || target.dataset[this.config.eventKey];
    paramsObj = Object.assign(paramsObj, this.getParams(target));
    if (forceKeepalive) {
      paramsObj.keepalive = true;
    }

    if (!paramsObj.eventName) {
      return;
    }

    // keepalive нужен только событиям, которые должны пережить выгрузку страницы.
    // По спецификации Fetch суммарное тело ВСЕХ keepalive-запросов на странице
    // ограничено 64 КБ; превышение → TypeError: Failed to fetch. Поэтому включаем
    // его лишь по явному флагу (paramsObj/data-ueb-params/config) либо когда
    // страница уже скрывается (pagehide/visibilitychange→hidden).
    const keepalive = paramsObj.keepalive === true
      || paramsObj.keepalive === 'true'
      || this.config.keepalive === true
      || document.visibilityState === 'hidden';
    delete paramsObj.keepalive;

    const params = new FormData();
    for (let [key, value] of Object.entries(paramsObj)) {
      params.append(key, value);
    }

    if (!document.dispatchEvent(new CustomEvent(this.config.beforeSendEvent, {
      bubbles: false, cancelable: true, detail: {
        params: params,
        target: target,
      }
    }))) {
      return;
    }

    const fetchOptions = {
      method: 'POST',
      body: params,
      headers: {},
    };
    if (keepalive) {
      fetchOptions.keepalive = true;
    }

    const response = await fetch(this.config.actionUrl, fetchOptions);

    const result = await response.json();
    if (deferRead) {
      this.scheduleRead();
    }
    if (result.success && target !== document && target.dataset[this.config.onceKey]) {
      target.removeAttribute(this.config.eventAttr);
    }

    return result;
  }

  getParams(target) {
    const params = {};
    if (target === document) return params;
    let paramsAttrValue = target.dataset[this.config.paramsKey];
    if (!paramsAttrValue) return params;
    paramsAttrValue = paramsAttrValue.split(';');
    paramsAttrValue.forEach(param => {
      const [key, value] = param.split(':');
      params[key] = value;
    });
    return params;
  }

  setCookie(name, value, options = {}) {
    options = {
      path: '/',
      ...options
    };

    if (options.expires instanceof Date) {
      options.expires = options.expires.toUTCString();
    }

    let updatedCookie = encodeURIComponent(name) + '=' + encodeURIComponent(value);

    for (let optionKey in options) {
      updatedCookie += '; ' + optionKey;
      let optionValue = options[optionKey];
      if (optionValue !== true) {
        updatedCookie += '=' + optionValue;
      }
    }

    document.cookie = updatedCookie;
  }

  getCookie(name) {
    let matches = document.cookie.match(new RegExp(
      '(?:^|; )' + name.replace(/([\.$?*|{}\(\)\[\]\\\/\+^])/g, '\\$1') + '=([^;]*)'
    ));
    return matches ? decodeURIComponent(matches[1]) : undefined;
  }

  close() {
    if (this.transport) {
      this.transport.pause();
    }
    this.closeLegacyEventSource();
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }

  }
}

const domReady = new Promise((resolve) => {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', resolve, {once: true});
  } else {
    resolve();
  }
});

// With transportStart=lazy the transport module is not requested here: EventBus loads it
// after the page load or at the first user action.
const lazyStart = window.uebConfig && window.uebConfig.transportStart === 'lazy'
  && window.uebConfig.transport !== 'legacy';

Promise.all([
  import(`./broadcastchannel.js${version}`),
  lazyStart ? Promise.resolve({}) : import(`./adaptive-transport.js${version}`),
  domReady,
]).then(([broadcastChannelModule, adaptiveTransportModule]) => {
  UebBroadcastChannel = broadcastChannelModule.default;
  AdaptiveTransport = adaptiveTransportModule.default;
  new EventBus();
}).catch((error) => {
  console.error('[UniversalEventBus] the bus did not start: failed to load its modules or to initialize', error);
});
