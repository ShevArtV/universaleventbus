export default class UebBroadcastChannel {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.config = {
      channelName: 'ueb',
      electionDelay: 120,
      types: {
        ping: 'ping',
        leader: 'leader',
        claim: 'claim',
        release: 'release',
        event: 'event',
        activity: 'activity',
      }
    };
    this.tabId = this.createTabId();
    this.isLeader = false;
    this.knownLeader = null;
    this.electionTimer = null;
    this.initialize();
  }

  initialize() {
    this.channel = new BroadcastChannel(this.config.channelName);
    document.addEventListener('visibilitychange', this.handleVisibilityChange.bind(this));
    this.channel.onmessage = (event) => this.handleMessage(event.data || {});

    if (!document.hidden) {
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
      if (this.knownLeader === message.tabId) {
        this.knownLeader = null;
      }
      if (!document.hidden) {
        this.electLeader();
      }
      break;
    case this.config.types.event:
      if (!this.isLeader) {
        this.eventBus.receiveTransportEvent(message.data, message.cursor);
      }
      break;
    case this.config.types.activity:
      if (this.isLeader) {
        this.eventBus.onRemoteActivity();
      }
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
    this.electLeader();
  }

  notifyActivity() {
    if (this.isLeader) return;
    this.channel.postMessage({type: this.config.types.activity, tabId: this.tabId});
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

  createTabId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}
