import UebBroadcastChannel from './broadcastchannel.js';

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
      eventSourceInitDelay: 100,
      expiredMessageId: 100000,
      intersectionObserverOptions: {
        threshold: 0.5,
        rootMargin: '0px',
      }
    };
    this.config = Object.assign(this.config, window.uebConfig);
    window.EventBus = this;
    new UebBroadcastChannel();
  }

  initialize() {
    setTimeout(() => {
      this.initializeEventSource();
    }, this.config.eventSourceInitDelay);

    const eventTargets = document.querySelectorAll(`[${this.config.eventAttr}]`);
    if (!eventTargets.length) return;

    this.initializeIntersectionObserver();
    this.initializeMutationObserver();
    this.addObservers(eventTargets);
  }

  initializeEventSource() {
    if (document.hidden) return;
    if (this.eventSource) return;
    this.eventSource = new EventSource(this.config.handlerPath);

    this.eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data) {
        document.dispatchEvent(new CustomEvent(this.config.dispatchEvent, {
          bubbles: false, cancelable: false, detail: {
            data: data,
            lastEventId: e.lastEventId
          }
        }));
        setTimeout(() => this.saveMessageId(e.lastEventId), 100);
      }
    };
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
        target.addEventListener(eventName, () => {
          this.sendEvent(target).then();
        });
        break;
      }
    });
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
    this.sendEvent(target).then(() => {
      target.setAttribute(this.config.eventAttr, type);
    });
  }

  checkClasses(target, classes) {
    if (!classes.length) return false;
    for (let i = 0; i < classes.length; i++) {
      if (target.closest(`.${classes[i]}`)) {
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
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
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

document.addEventListener('DOMContentLoaded', () => {
  new EventBus();
});
