
export default class UebBroadcastChannel {
  constructor() {
    this.config = {
      channelName: 'ueb',
      types: {
        ping: 'ping',
        tabChanged: 'active_tab_changed',
        active: 'active',
      }
    };
    this.isActive = false;
    this.eventSource = null;
    this.initialize();
  }
  initialize(){
    this.channel = new BroadcastChannel(this.config.channelName);
    this.eventSource = window.EventBus;

    document.addEventListener('visibilitychange', this.handleVisibilityChange.bind(this));

    this.channel.onmessage = (event) => {
      if (event.data.type === this.config.types.ping && this.isActive) {
        this.channel.postMessage({ type: this.config.types.active });
      }

      if (event.data.type === this.config.types.tabChanged && this.isActive) {
        this.close();
      }
    };

    this.checkActiveTabs().then(() => {});

  }

  async checkActiveTabs() {
    this.channel.postMessage({ type: this.config.types.ping });

    await new Promise(resolve => setTimeout(resolve, 100));

    if (!this.isActive) {
      this.becomeActive();
    }
  }

  becomeActive() {
    this.isActive = true;
    this.channel.postMessage({ type: this.config.types.tabChanged });
    this.createEventSource();
  }

  createEventSource() {
    this.eventSource && this.eventSource.initialize();
  }

  handleVisibilityChange() {
    if (document.hidden) {
      this.close();
      this.isActive = false;
    } else {
      this.checkActiveTabs().then();
    }
  }

  close() {
    if (this.eventSource) {
      this.eventSource.close();
    }
  }
}
