class EventBus {
  constructor() {
    if (window.EventBus) return window.EventBus;
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

    window.EventBus = this;
  }

  initialize() {
    this.eventSource = new EventSource(this.config.handlerPath);
    this.eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data) {
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
          const target = mutation.target;

          if(this.checkClasses(target, this.config.openClasses)) {
            this.sendEvent(mutation.target);
          }
          if(this.checkClasses(target, this.config.closeClasses)) {
            this.sendEvent(mutation.target);
          }
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

  checkClasses(target, classes) {
    if(!classes.length) return false;
    for(let i = 0; i < classes.length; i++) {
      if(target.closest(classes[i])) {
        return true;
      }
    }
    return false;
  }

  async sendEvent(target, paramsObj = {}) {
    paramsObj.eventName = paramsObj.eventName || target.dataset[this.config.eventKey];
    paramsObj = Object.assign(paramsObj, this.getParams(target));

    if (!paramsObj.eventName) {
      return;
    }
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
      headers: {}
    };

    const response = await fetch(this.config.actionUrl, fetchOptions);

    const result = await response.json();
    if (result.success && target !== document && target.dataset[this.config.onceKey]) {
      target.removeAttribute(this.config.eventAttr);
    }

    return result;
  }

  getParams(target) {
    const params = {};
    if(target === document) return params;
    let paramsAttrValue = target.dataset[this.config.paramsKey];
    if (!paramsAttrValue) return params;
    paramsAttrValue = paramsAttrValue.split(';');
    paramsAttrValue.forEach(param => {
      const [key, value] = param.split(':');
      params[key] = value;
    });
    return params;
  }

}

new EventBus();
