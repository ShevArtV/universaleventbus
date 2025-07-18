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
        if (!document.dispatchEvent(new CustomEvent('eventbus', {
          bubbles: true,
          cancelable: true,
          detail: {
            data: data,
          }
        }))) {
          return;
        }

        if(typeof window[window.uebConfig.dataParamName] === 'undefined') {
          window[window.uebConfig.dataParamName] = [];
        }
        data.pushed && window[window.uebConfig.dataParamName].push(data.pushed);
      }
    }
  }
}

new Eventbus();
