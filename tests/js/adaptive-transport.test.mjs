import assert from 'node:assert/strict';
import test from 'node:test';

import AdaptiveTransport from '../../assets/components/universaleventbus/js/adaptive-transport.js';

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

  runDelay(delay) {
    const entry = [...this.items.entries()].find(([, item]) => item.delay === delay);
    assert.ok(entry, `Timer with delay ${delay} exists`);
    const [id, item] = entry;
    this.items.delete(id);
    item.callback();
  }

  delays() {
    return [...this.items.values()].map((item) => item.delay);
  }
}

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.closed = false;
    this.listeners = new Map();
    FakeEventSource.instances.push(this);
  }

  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }

  close() {
    this.closed = true;
  }
}

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value),
  };
}

function createTransport(overrides = {}) {
  FakeEventSource.instances = [];
  const timers = new FakeTimers();
  const events = [];
  const replays = [];
  const states = [];
  const fetchCalls = [];
  const responses = overrides.responses || [];
  const fetch = async (url) => {
    fetchCalls.push(url);
    const result = responses.shift() || {success: true, cursor: 0, events: []};
    return {
      ok: true,
      status: 200,
      json: async () => result,
    };
  };
  const transport = new AdaptiveTransport({
    handlerPath: '/ssehandler.php',
    streamIdleTimeout: 30000,
    cursorPollInitial: 2000,
    cursorPollMax: 30000,
    cursorPollJitter: 0,
  }, {
    onEvent: (data, cursor) => events.push({data, cursor}),
    onReplay: (data, cursor) => replays.push({data, cursor}),
    onStateChange: (state) => states.push(state),
  }, {
    fetch,
    EventSource: FakeEventSource,
    document: {hidden: false},
    location: {origin: 'https://example.test'},
    storage: createStorage(),
    setTimeout: timers.setTimeout.bind(timers),
    clearTimeout: timers.clearTimeout.bind(timers),
    random: () => 0.5,
  });
  return {transport, timers, events, replays, states, fetchCalls};
}

test('active SSE becomes cursor polling after idle and reopens on activity', async () => {
  const {transport, timers, fetchCalls} = createTransport();

  transport.setLeader(true);
  assert.equal(transport.state, 'active_sse');
  assert.equal(FakeEventSource.instances.length, 1);
  assert.match(FakeEventSource.instances[0].url, /mode=stream/);

  timers.runDelay(30000);
  assert.equal(transport.state, 'idle_poll');
  assert.equal(FakeEventSource.instances[0].closed, true);
  assert.deepEqual(timers.delays(), [2000]);

  timers.runDelay(2000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0], /mode=poll/);
  assert.deepEqual(timers.delays(), [4000]);

  transport.notifyActivity();
  assert.equal(transport.state, 'active_sse');
  assert.equal(FakeEventSource.instances.length, 2);
});

test('cursor poll event upgrades to SSE and persists cursor', async () => {
  const {transport, timers, events} = createTransport({
    responses: [{
      success: true,
      cursor: 42,
      events: [{cursor: 42, data: {eventId: 'event-42'}}],
    }],
  });

  transport.setLeader(true);
  transport.enterIdle();
  timers.runDelay(2000);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(transport.cursor, 42);
  assert.deepEqual(events, [{data: {eventId: 'event-42'}, cursor: 42}]);
  assert.equal(transport.state, 'active_sse');
  assert.equal(FakeEventSource.instances.length, 2);
  assert.match(FakeEventSource.instances[1].url, /cursor=42/);
});

test('hidden or follower tab has no active transport', () => {
  const {transport, timers} = createTransport();

  transport.setLeader(true);
  transport.setVisible(false);
  assert.equal(transport.state, 'paused');
  assert.equal(FakeEventSource.instances[0].closed, true);
  assert.deepEqual(timers.delays(), []);

  transport.setVisible(true);
  assert.equal(transport.state, 'active_sse');
  transport.setLeader(false);
  assert.equal(transport.state, 'paused');
  assert.deepEqual(timers.delays(), []);
});

test('SSE message advances cursor and resets idle timeout', () => {
  const {transport, timers, events} = createTransport();

  transport.setLeader(true);
  const source = FakeEventSource.instances[0];
  source.onmessage({lastEventId: '7', data: '{"eventId":"event-7"}'});

  assert.equal(transport.cursor, 7);
  assert.deepEqual(events, [{data: {eventId: 'event-7'}, cursor: 7}]);
  assert.deepEqual(timers.delays(), [30000]);
});

test('follower catch-up replays missed events once without opening a stream', async () => {
  const {transport, events, replays, fetchCalls} = createTransport({
    responses: [{
      success: true,
      cursor: 7,
      events: [{cursor: 7, data: {eventId: 'detail-7'}}],
    }],
  });

  await transport.catchUp();

  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0], /mode=poll/);
  assert.deepEqual(replays, [{data: {eventId: 'detail-7'}, cursor: 7}]);
  assert.deepEqual(events, []);
  assert.equal(transport.cursor, 7);
  assert.equal(transport.state, 'paused');
  assert.equal(FakeEventSource.instances.length, 0);
});
