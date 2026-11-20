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
  const fetch = overrides.fetch ? (url) => { fetchCalls.push(url); return overrides.fetch(url); } : async (url) => {
    fetchCalls.push(url);
    const result = responses.shift() || {success: true, cursor: 0, events: []};
    return {
      ok: true,
      status: 200,
      json: async () => result,
    };
  };
  const transport = new AdaptiveTransport(Object.assign({
    handlerPath: '/ssehandler.php',
    streamIdleTimeout: 30000,
    cursorPollInitial: 2000,
    cursorPollMax: 30000,
    cursorPollJitter: 0,
  }, overrides.config || {}), {
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
    random: overrides.random || (() => 0.5),
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

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const pollCfg = (extra = {}) => ({config: Object.assign({transport: 'poll', streamIdleTimeout: 2000}, extra)});
const eventResponse = (cursor) => ({success: true, cursor, events: [{cursor, data: {eventId: `e${cursor}`}}]});

test('poll mode: no EventSource, immediate poll on activation, pause does not grow in window', async () => {
  const {transport, timers, fetchCalls} = createTransport(pollCfg());
  transport.setLeader(true);
  await flush();
  assert.equal(FakeEventSource.instances.length, 0);
  assert.equal(transport.state, 'active_poll');
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0], /mode=poll/);
  assert.equal(transport.pollDelay, 2000);
  assert.deepEqual(timers.delays().sort(), [2000, 2000]);
});

for (const order of ['window-ends-first', 'poll-first']) {
  test(`poll mode: event 300ms after click is delivered by the poll planned at <=2.4s (${order})`, async () => {
    const {transport, timers, events} = createTransport(Object.assign(pollCfg({cursorPollJitter: 0.2}), {
      random: () => 1, // jitter +20%
      responses: [{success: true, cursor: 0, events: []}, eventResponse(5)],
    }));
    transport.setLeader(true); // click-like entering: immediate empty poll
    await flush();
    const plannedPoll = transport.pollTimer;
    assert.notEqual(plannedPoll, null);
    assert.ok(timers.delays().includes(2400));

    if (order === 'window-ends-first') {
      timers.runDelay(2000); // idleTimer fires before pollTimer
      assert.equal(transport.state, 'idle_poll');
      assert.equal(transport.pollTimer, plannedPoll, 'planned poll is not re-armed');
    }
    timers.runDelay(2400);
    await flush();
    assert.equal(events.length, 1);
    assert.equal(events[0].data.eventId, 'e5');
    assert.equal(FakeEventSource.instances.length, 0);
    assert.equal(transport.state, 'active_poll');
    assert.equal(transport.pollDelay, 2000);
  });
}

test('poll mode: repeated activity extends the window without an extra poll', async () => {
  const {transport, fetchCalls} = createTransport(pollCfg());
  transport.setLeader(true);
  await flush();
  transport.notifyActivity();
  transport.notifyActivity();
  await flush();
  assert.equal(fetchCalls.length, 1);
});

test('poll mode: no second poll while one is in flight', async () => {
  let release;
  const {transport, fetchCalls} = createTransport(Object.assign(pollCfg(), {
    fetch: () => new Promise((resolve) => {
      release = () => resolve({ok: true, status: 200, json: async () => ({success: true, cursor: 0, events: []})});
    }),
  }));
  transport.setLeader(true);
  assert.equal(fetchCalls.length, 1);
  transport.enterIdle();
  transport.notifyActivity(); // enters the window again while the poll is pending
  assert.equal(fetchCalls.length, 1);
  release();
  await flush();
  assert.equal(transport.polling, false);
});

test('poll mode: pause grows 2s -> 30s only after the window', async () => {
  const {transport, timers} = createTransport(pollCfg());
  transport.setLeader(true);
  await flush();
  timers.runDelay(2000); // window ends; the planned poll stays
  assert.equal(transport.state, 'idle_poll');
  assert.equal(transport.pollDelay, 2000);
  timers.runDelay(2000); // planned poll: empty, pause grows
  await flush();
  assert.equal(transport.pollDelay, 4000);
  assert.deepEqual(timers.delays(), [4000]);
  assert.equal(FakeEventSource.instances.length, 0);
});

test('poll mode: answer arriving after the window ends is judged by the state at answer time', async () => {
  let release;
  const {transport, timers} = createTransport(Object.assign(pollCfg(), {
    fetch: () => new Promise((resolve) => {
      release = () => resolve({ok: true, status: 200, json: async () => ({success: true, cursor: 0, events: []})});
    }),
  }));
  transport.setLeader(true);
  timers.runDelay(2000); // window ends while the poll is in flight
  assert.equal(transport.state, 'idle_poll');
  release();
  await flush();
  assert.equal(transport.pollDelay, 4000);
});

test('poll mode: events from an idle poll open a window, never a stream', async () => {
  const {transport, events} = createTransport(Object.assign(pollCfg({streamIdleTimeout: 30000}), {
    responses: [eventResponse(9)],
  }));
  transport.setLeader(true);
  transport.enterIdle();
  transport.pollDelay = 8000;
  await flush();
  assert.equal(events.length, 1);
  assert.equal(FakeEventSource.instances.length, 0);
  assert.equal(transport.pollDelay, 2000);
});

test('poll mode: pause clears all timers', async () => {
  const {transport, timers} = createTransport(pollCfg());
  transport.setLeader(true);
  await flush();
  transport.pause();
  assert.deepEqual(timers.delays(), []);
  assert.equal(transport.state, 'paused');
});

// ---- transportStart=lazy: one read before the first action, stream only after it ----

const lazyCfg = (extra = {}) => ({config: Object.assign({transportStart: 'lazy'}, extra)});

test('lazy: leader reads the cursor once, opens no stream, schedules nothing', async () => {
  const {transport, timers, events, fetchCalls} = createTransport(Object.assign(lazyCfg(), {
    responses: [eventResponse(5)],
  }));
  transport.setLeader(true);
  await flush();
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0], /mode=poll/);
  assert.equal(events.length, 1);
  assert.equal(FakeEventSource.instances.length, 0);
  assert.deepEqual(timers.delays(), []);
  assert.equal(transport.state, 'lazy_wait');
});

test('lazy: empty answer — still no stream and no timers', async () => {
  const {transport, timers, fetchCalls} = createTransport(lazyCfg());
  transport.setLeader(true);
  await flush();
  assert.equal(fetchCalls.length, 1);
  assert.equal(FakeEventSource.instances.length, 0);
  assert.deepEqual(timers.delays(), []);
});

test('lazy: follower does not read and does not open a stream', async () => {
  const {transport, fetchCalls} = createTransport(lazyCfg());
  transport.setLeader(false);
  await flush();
  assert.equal(fetchCalls.length, 0);
  assert.equal(FakeEventSource.instances.length, 0);
});

test('lazy: hidden tab reads nothing until it becomes visible', async () => {
  const {transport, fetchCalls} = createTransport(lazyCfg());
  transport.setVisible(false);
  transport.setLeader(true);
  await flush();
  assert.equal(fetchCalls.length, 0);
  transport.setVisible(true);
  await flush();
  assert.equal(fetchCalls.length, 1);
  assert.equal(FakeEventSource.instances.length, 0);
});

test('lazy: first activity opens the stream', async () => {
  const {transport} = createTransport(lazyCfg());
  transport.setLeader(true);
  await flush();
  transport.notifyActivity();
  await flush();
  assert.equal(transport.state, 'active_sse');
  assert.equal(FakeEventSource.instances.length, 1);
});

test('lazy: activity during the read — stream opens after it, event is delivered once', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const {transport, events} = createTransport({
    config: {transportStart: 'lazy'},
    fetch: async () => {
      await gate;
      return {ok: true, status: 200, json: async () => ({success: true, cursor: 7, events: [{cursor: 7, data: {eventId: 'a'}}]})};
    },
  });
  transport.setLeader(true);
  transport.notifyActivity();
  assert.equal(FakeEventSource.instances.length, 0);
  release();
  for (let i = 0; i < 5; i++) await flush();
  assert.equal(events.length, 1);
  assert.equal(FakeEventSource.instances.length, 1);
  assert.match(FakeEventSource.instances[0].url, /cursor=7/);
});

test('lazy: activity of a non-leader tab arms the transport for a later lead', async () => {
  const {transport} = createTransport(lazyCfg());
  transport.notifyActivity();
  transport.setLeader(true);
  assert.equal(transport.state, 'active_sse');
});

test('lazy + poll mode: first activity opens the polling window, never a stream', async () => {
  const {transport, fetchCalls} = createTransport(lazyCfg({transport: 'poll'}));
  transport.setLeader(true);
  await flush();
  assert.equal(fetchCalls.length, 1);
  transport.notifyActivity();
  await flush();
  assert.equal(transport.state, 'active_poll');
  assert.equal(FakeEventSource.instances.length, 0);
  assert.equal(fetchCalls.length, 2);
});

test('immediate (default): leader opens the stream at once', async () => {
  const {transport} = createTransport();
  transport.setLeader(true);
  assert.equal(transport.state, 'active_sse');
});

test('lazy: readOnce reads the cursor again without a stream or timers', async () => {
  const {transport, timers, fetchCalls} = createTransport(lazyCfg());
  transport.setLeader(true);
  await flush();
  await transport.readOnce();
  assert.equal(fetchCalls.length, 2);
  assert.match(fetchCalls[1], /mode=poll/);
  assert.equal(FakeEventSource.instances.length, 0);
  assert.deepEqual(timers.delays(), []);
});

test('lazy: readOnce during a read — one more read after it, no stream', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const {transport} = createTransport({
    config: {transportStart: 'lazy'},
    fetch: async () => {
      calls++;
      if (calls === 1) await gate;
      return {ok: true, status: 200, json: async () => ({success: true, cursor: 0, events: []})};
    },
  });
  transport.setLeader(true);
  transport.readOnce().then();
  release();
  for (let i = 0; i < 8; i++) await flush();
  assert.equal(calls, 2);
  assert.equal(FakeEventSource.instances.length, 0);
});

test('lazy: readOnce does nothing for a follower and after arming', async () => {
  const {transport, fetchCalls} = createTransport(lazyCfg());
  await transport.readOnce();
  assert.equal(fetchCalls.length, 0);
  transport.setLeader(true);
  transport.notifyActivity();
  await flush();
  const before = fetchCalls.length;
  await transport.readOnce();
  assert.equal(fetchCalls.length, before);
});
