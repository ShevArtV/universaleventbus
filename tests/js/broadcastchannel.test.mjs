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
  };
}

test('one tab owns transport, relays events and yields it to the active tab', async () => {
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
    focused: false,
    hasFocus() {
      return this.focused;
    },
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

  // The user acts in the second tab: it takes the lead, the first one yields.
  second.takeLead();
  assert.equal(second.isLeader, true);
  assert.equal(first.isLeader, false);
  assert.equal(first.knownLeader, second.tabId);
  assert.deepEqual(firstBus.leadership, [true, false]);
  assert.deepEqual(secondBus.leadership, [true]);

  second.broadcastEvent({eventId: 'evt-2'}, 13);
  assert.deepEqual(firstBus.received, [{data: {eventId: 'evt-2'}, cursor: 13}]);

  // A tab opened with focus leads at once, without an election.
  document.focused = true;
  const thirdBus = createEventBus();
  const third = new UebBroadcastChannel(thirdBus);
  assert.equal(third.isLeader, true);
  assert.equal(second.isLeader, false);
  assert.equal(thirdBus.catchUps, 0);

  // The leader leaves: visible windows do not grab the stream.
  document.focused = false;
  third.handleMessage({type: 'release', tabId: 'gone'});
  second.handleMessage({type: 'release', tabId: third.tabId});
  timers.runAll();
  assert.equal(second.isLeader, false);
  assert.equal(second.knownLeader, null);

  // A duplicated tab with the same key takes a new one.
  const key = second.tabKey;
  const dupe = new UebBroadcastChannel(createEventBus());
  dupe.tabKey = key;
  dupe.channel.postMessage({type: 'hello', tabId: dupe.tabId, tabKey: key});
  assert.equal(second.tabKey, key);
  assert.notEqual(dupe.tabKey, key);
});
