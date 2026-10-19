export default class UebBroadcastChannel {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.config = {
      channelName: 'ueb',
      tabKeyStorageKey: 'ueb_tab_key',
      electionDelay: 120,
      types: {
        ping: 'ping',
        leader: 'leader',
        claim: 'claim',
        release: 'release',
        event: 'event',
        takeover: 'takeover',
        hello: 'hello',
        tabKeyTaken: 'tab-key-taken',
      }
    };
    this.tabId = this.createTabId();
    this.tabKey = this.readTabKey();
    this.isLeader = false;
    this.knownLeader = null;
    this.electionTimer = null;
    this.caughtUp = false;
    this.initialize();
  }

  initialize() {
    this.channel = new BroadcastChannel(this.config.channelName);
    document.addEventListener('visibilitychange', this.handleVisibilityChange.bind(this));
    this.channel.onmessage = (event) => this.handleMessage(event.data || {});
    // A duplicated tab inherits sessionStorage: a live tab with the same key makes it take a new one.
    this.channel.postMessage({type: this.config.types.hello, tabId: this.tabId, tabKey: this.tabKey});

    if (document.hidden) return;
    // The focused tab is where the user acts now: it reads the bus itself.
    if (document.hasFocus()) {
      this.takeLead();
    } else {
      this.electLeader();
    }
  }

  handleMessage(message) {
    if (!message.type || message.tabId === this.tabId) return;

    switch (message.type) {
    case this.config.types.ping:
      if (this.isLeader) {
        this.channel.postMessage({type: this.config.types.leader, tabId: this.tabId});
      }
      break;
    case this.config.types.leader:
    case this.config.types.claim:
      this.handleLeaderClaim(message.tabId);
      break;
    case this.config.types.release:
      // The stream waits for the tab where the user acts next: a leaving page's
      // events belong to its tab, not to whichever window happens to be visible.
      if (this.knownLeader === message.tabId) {
        this.knownLeader = null;
      }
      break;
    case this.config.types.hello:
      if (message.tabKey === this.tabKey) {
        this.channel.postMessage({type: this.config.types.tabKeyTaken, tabId: this.tabId, tabKey: this.tabKey});
      }
      break;
    case this.config.types.tabKeyTaken:
      if (message.tabKey === this.tabKey) {
        this.tabKey = this.createTabKey();
      }
      break;
    case this.config.types.event:
      if (!this.isLeader) {
        this.eventBus.receiveTransportEvent(message.data, message.cursor);
      }
      break;
    case this.config.types.takeover:
      this.demote();
      this.knownLeader = message.tabId;
      this.clearElectionTimer();
      break;
    }
  }

  handleLeaderClaim(tabId) {
    if (!tabId) return;

    if (this.isLeader) {
      // Simultaneous elections resolve deterministically: the larger id wins.
      if (tabId > this.tabId) {
        this.demote();
        this.knownLeader = tabId;
      } else {
        this.channel.postMessage({type: this.config.types.claim, tabId: this.tabId});
      }
      return;
    }

    this.knownLeader = tabId;
    this.clearElectionTimer();
    // Events published while this page rendered may already be taken by the
    // leader before this tab listened to the channel.
    if (!this.caughtUp) {
      this.caughtUp = true;
      this.eventBus.catchUp();
    }
  }

  electLeader() {
    if (document.hidden || this.isLeader) return;
    this.knownLeader = null;
    this.channel.postMessage({type: this.config.types.ping, tabId: this.tabId});
    this.clearElectionTimer();
    this.electionTimer = window.setTimeout(() => {
      this.electionTimer = null;
      if (!this.knownLeader && !document.hidden) {
        this.becomeLeader();
      }
    }, this.config.electionDelay);
  }

  becomeLeader() {
    if (document.hidden || this.isLeader) return;
    this.isLeader = true;
    this.caughtUp = true;
    this.knownLeader = this.tabId;
    this.channel.postMessage({type: this.config.types.claim, tabId: this.tabId});
    this.eventBus.setTransportLeader(true);
  }

  demote() {
    if (!this.isLeader) return;
    this.isLeader = false;
    this.eventBus.setTransportLeader(false);
  }

  handleVisibilityChange() {
    this.eventBus.setTransportVisible(!document.hidden);
    if (document.hidden) {
      if (this.isLeader) {
        this.channel.postMessage({type: this.config.types.release, tabId: this.tabId});
      }
      this.demote();
      this.knownLeader = null;
      this.clearElectionTimer();
      return;
    }
    if (document.hasFocus()) {
      this.takeLead();
    } else {
      this.electLeader();
    }
  }

  /**
   * The tab where the user acts takes the lead at once: events caused by the
   * action then come from its own transport, not from another window.
   */
  takeLead() {
    if (document.hidden || this.isLeader) return;
    this.clearElectionTimer();
    this.isLeader = true;
    this.caughtUp = true;
    this.knownLeader = this.tabId;
    this.channel.postMessage({type: this.config.types.takeover, tabId: this.tabId});
    this.eventBus.setTransportLeader(true);
  }

  broadcastEvent(data, cursor) {
    if (!this.isLeader) return;
    this.channel.postMessage({
      type: this.config.types.event,
      tabId: this.tabId,
      data: data,
      cursor: cursor,
    });
  }

  clearElectionTimer() {
    if (this.electionTimer === null) return;
    window.clearTimeout(this.electionTimer);
    this.electionTimer = null;
  }

  readTabKey() {
    try {
      const stored = window.sessionStorage.getItem(this.config.tabKeyStorageKey);
      if (stored) return stored;
    } catch {
      // Without sessionStorage the key lives as long as the page.
    }
    return this.createTabKey();
  }

  createTabKey() {
    const tabKey = this.createTabId();
    try {
      window.sessionStorage.setItem(this.config.tabKeyStorageKey, tabKey);
    } catch {
      // Same as above.
    }
    return tabKey;
  }

  createTabId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}
