class Eventbus {
  constructor() {
    if (window.Eventbus) return window.Eventbus;
    this.config = {
      eventAttr: 'data-ueb-event',
      eventKey: 'uebEvent',
      dispatchEvent: 'eventbus',
      beforeSendEvent: 'eventbus:before:send',
      onceKey: 'uebOnce',
      paramsKey: 'uebParams',
      intersectionObserverOptions: {
        threshold: 0.5,
        rootMargin: '0px',
      }
    };
    this.config = Object.assign(this.config, window.uebConfig);
    this.initialize();
  }

  initialize() {
    this.eventSource = new EventSource(this.config.handlerPath);
    this.eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.error) {
        console.warn(data.error);
        this.eventSource.close();
      } else {
        document.dispatchEvent(new CustomEvent(this.config.dispatchEvent, {
          bubbles: false, cancelable: false, detail: {
            data: data,
          }
        }));
      }
    };

    const eventTargets = document.querySelectorAll(`[${this.config.eventAttr}]`);
    if (!eventTargets.length) return;

    const intersectionObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const target = entry.target;
        if (target.hasAttribute(this.config.eventAttr)) {
          target.setAttribute(this.config.eventAttr, entry.isIntersecting ? 'show' : 'hide');
          this.sendEvent(target);
        }
      });
    }, this.config.intersectionObserverOptions);


    const mutationObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class' && mutation.target.hasAttribute(this.config.eventAttr)) {
          const classList = Array.from(mutation.target.classList);
          const openIntersection = classList.filter(item => this.config.openClasses.includes(item));
          const closeIntersection = classList.filter(item => this.config.closeClasses.includes(item));
          const target = mutation.target;

          if (openIntersection.length || !closeIntersection.length) {
            target.setAttribute(this.config.eventAttr, 'open');
          }
          if (!openIntersection.length || closeIntersection.length) {
            target.setAttribute(this.config.eventAttr, 'close');
          }
          this.sendEvent(mutation.target);
        }
      });
    });


    eventTargets.forEach((target) => {
      const eventName = target.dataset[this.config.eventKey];
      switch (eventName) {
      case 'show':
      case 'hide':
        intersectionObserver.observe(target);
        break;
      case 'open':
      case 'close':
        mutationObserver.observe(target, {
          attributes: true,
          attributeFilter: ['class'],
        });
        break;
      default:
        target.addEventListener(eventName, () => {
          this.sendEvent(target);
        });
        break;
      }
    });
  }

  async sendEvent(target) {
    const eventName = target.dataset[this.config.eventKey];
    if (!eventName) {
      return;
    }
    const params = this.getParams(target);
    if (!params.has('eventName')) {
      params.append('eventName', eventName);
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
      headers: {}
    };

    const response = await fetch(this.config.actionUrl, fetchOptions);

    const result = await response.json();
    if (result.success && target.dataset[this.config.onceKey]) {
      target.removeAttribute(this.config.eventAttr);
    }
  }

  getParams(target) {
    const params = new FormData();
    let paramsAttrValue = target.dataset[this.config.paramsKey];
    if (!paramsAttrValue) return params;
    paramsAttrValue = paramsAttrValue.split(';');
    paramsAttrValue.forEach(param => {
      const [key, value] = param.split(':');
      params.append(key, value);
    });
    return params;
  }

}

new Eventbus();
