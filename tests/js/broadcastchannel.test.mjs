import assert from 'node:assert/strict';
import test from 'node:test';

class FakeTimers {
  constructor() {
    this.nextId = 1;
    this.items = new Map();
  }

  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.items.set(id, {callback, delay});
    return id;
  }

  clearTimeout(id) {
    this.items.delete(id);
  }

  runAll() {
    const items = [...this.items.values()];
    this.items.clear();
    items.forEach((item) => item.callback());
  }
}

class FakeChannel {
  static channels = [];

  constructor(name) {
    this.name = name;
    this.onmessage = null;
    FakeChannel.channels.push(this);
  }

  postMessage(data) {
    FakeChannel.channels
      .filter((channel) => channel !== this && channel.name === this.name)
      .forEach((channel) => channel.onmessage && channel.onmessage({data}));
  }
}

function createEventBus() {
  return {
    leadership: [],
    received: [],
    remoteActivities: 0,
    catchUps: 0,
    catchUp() {
      this.catchUps++;
    },
    setTransportLeader(value) {
      this.leadership.push(value);
    },
    setTransportVisible() {},
    receiveTransportEvent(data, cursor) {
      this.received.push({data, cursor});
    },
    onRemoteActivity() {
      this.remoteActivities++;
    },
  };
}

test('one tab owns transport and relays events/activity', async () => {
  const timers = new FakeTimers();
  let uuid = 0;
  FakeChannel.channels = [];
  globalThis.window = {
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
    crypto: {randomUUID: () => `tab-${++uuid}`},
  };
  globalThis.document = {
    hidden: false,
    addEventListener() {},
  };
  globalThis.BroadcastChannel = FakeChannel;

  const {default: UebBroadcastChannel} = await import(
    '../../assets/components/universaleventbus/js/broadcastchannel.js'
  );
  const firstBus = createEventBus();
  const first = new UebBroadcastChannel(firstBus);
  timers.runAll();
  assert.equal(first.isLeader, true);

  const secondBus = createEventBus();
  const second = new UebBroadcastChannel(secondBus);
  timers.runAll();
  assert.equal(first.isLeader, true);
  assert.equal(second.isLeader, false);

  assert.equal(firstBus.catchUps, 0);
  assert.equal(secondBus.catchUps, 1);

  first.broadcastEvent({eventId: 'evt-1'}, 12);
  assert.deepEqual(secondBus.received, [{data: {eventId: 'evt-1'}, cursor: 12}]);

  second.notifyActivity();
  assert.equal(firstBus.remoteActivities, 1);
});
