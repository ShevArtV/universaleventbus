class Eventbus {
  constructor() {
    if (window.Eventbus) return window.Eventbus;
    this.initialize();
  }

  initialize() {
    this.eventSource = new EventSource(window.uebConfig.handlerPath);
    this.eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.error) {
        console.warn(data.error);
        this.eventSource.close();
      } else {
        document.dispatchEvent(new CustomEvent('eventbus', {
          bubbles: false,
          cancelable: false,
          detail: {
            data: data,
          }
        }));
      }
    };
  }
}

new Eventbus();
