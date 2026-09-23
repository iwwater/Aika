import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalGreetingScheduler, localGreetingBand } from '../../desktop/local-greeting.js';

/** A controllable clock so the 45-minute idle and 6-hour cooldown rules are testable without waiting. */
function fixedClock(startIso: string) {
  let now = new Date(startIso).getTime();
  return {
    now: () => now,
    set: (iso: string) => { now = new Date(iso).getTime(); },
    advance: (ms: number) => { now += ms; },
  };
}

const MORNING = '2026-09-23T08:00:00';
const DAY = '2026-09-23T14:00:00';
const EVENING = '2026-09-23T20:00:00';
const NIGHT = '2026-09-23T23:30:00';

test('ACCEPT-02 local greeting band boundaries cover the four local periods', () => {
  assert.equal(localGreetingBand(new Date(MORNING)), 'morning');
  assert.equal(localGreetingBand(new Date(DAY)), 'day');
  assert.equal(localGreetingBand(new Date(EVENING)), 'evening');
  assert.equal(localGreetingBand(new Date(NIGHT)), 'night');
  assert.equal(localGreetingBand(new Date('2026-09-23T05:00:00')), 'morning', '05:00 starts the morning band');
  assert.equal(localGreetingBand(new Date('2026-09-23T11:00:00')), 'day', '11:00 starts the day band');
  assert.equal(localGreetingBand(new Date('2026-09-23T18:00:00')), 'evening', '18:00 starts the evening band');
  assert.equal(localGreetingBand(new Date('2026-09-23T23:00:00')), 'night', '23:00 starts the night band');
  assert.equal(localGreetingBand(new Date('2026-09-23T04:59:00')), 'night', '04:59 is still night');
});

test('ACCEPT-02 preview returns the current band text without waiting for the idle window', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    [MORNING, 'morning'], [DAY, 'day'], [EVENING, 'evening'], [NIGHT, 'night'],
  ];
  for (const [iso, band] of cases) {
    const clock = fixedClock(iso);
    // The scheduler has just seen an interaction, so `tick` would refuse for another 45 minutes.
    const scheduler = new LocalGreetingScheduler({ now: clock.now });
    assert.equal(scheduler.tick({ visible: true, busy: false }), null, `${band}: tick is correctly idle-gated`);

    const preview = scheduler.preview();
    assert.ok(preview, `${band}: preview must not be idle-gated`);
    assert.equal(preview.band, band, `${band}: preview uses the current local band`);
    assert.equal(typeof preview.text, 'string');
    assert.ok(preview.text.length > 0, `${band}: preview carries real template text`);
    assert.equal(preview.occurredAt, clock.now(), `${band}: preview is stamped with the injected clock`);
  }
});

test('ACCEPT-02 preview never writes the automatic greeting bookkeeping', () => {
  const clock = fixedClock(MORNING);
  const scheduler = new LocalGreetingScheduler({ now: clock.now });

  const preview = scheduler.preview();
  assert.ok(preview);

  // A preview must consume neither the day key nor the cooldown. Right after it, a genuinely idle tick
  // must still be able to deliver the real automatic greeting for the same band and day.
  clock.advance(46 * 60 * 1000);
  const automatic = scheduler.tick({ visible: true, busy: false });
  assert.ok(automatic, 'the automatic greeting is still available after a preview');
  assert.equal(automatic.key, preview.key, 'preview did not consume the day key');
  assert.equal(automatic.text, preview.text, 'the automatic greeting uses the same band template');
});

test('ACCEPT-02 preview is refused while the app is busy or disabled', () => {
  const clock = fixedClock(DAY);
  const scheduler = new LocalGreetingScheduler({ now: clock.now });
  assert.equal(scheduler.preview({ busy: true }), null, 'a busy app must not preview over a higher-priority bubble');
  scheduler.setEnabled(false);
  assert.equal(scheduler.preview(), null, 'a disabled scheduler must not preview');
  scheduler.setEnabled(true);
  assert.ok(scheduler.preview(), 're-enabling restores preview capability');
});

test('ACCEPT-02 the 45-minute idle rule and 6-hour cooldown survive unchanged', () => {
  const clock = fixedClock(MORNING);
  const scheduler = new LocalGreetingScheduler({ now: clock.now });

  assert.equal(scheduler.tick({ visible: true, busy: false }), null, 'not idle yet');

  clock.advance(44 * 60 * 1000);
  assert.equal(scheduler.tick({ visible: true, busy: false }), null, 'one minute short of idle');

  clock.advance(2 * 60 * 1000);
  const first = scheduler.tick({ visible: true, busy: false });
  assert.ok(first, 'the first greeting fires once idle');
  assert.equal(first.band, 'morning');

  // Same band, still inside the cooldown: refused even though the idle condition is met again.
  clock.advance(46 * 60 * 1000);
  assert.equal(scheduler.tick({ visible: true, busy: false }), null, 'cooldown and same-band key both refuse');

  // Past the cooldown into a new band: allowed again.
  clock.set(EVENING);
  const second = scheduler.tick({ visible: true, busy: false });
  assert.ok(second, 'a later band fires after the idle window');
  assert.equal(second.band, 'evening');
});

test('ACCEPT-02 a busy app consumes the slot rather than queueing a stale greeting', () => {
  const clock = fixedClock(MORNING);
  const scheduler = new LocalGreetingScheduler({ now: clock.now });
  clock.advance(46 * 60 * 1000);
  assert.equal(scheduler.tick({ visible: true, busy: true }), null, 'busy suppresses the greeting');
  assert.equal(scheduler.tick({ visible: true, busy: false }), null, 'the slot was consumed, not queued');
});

test('ACCEPT-02 restored lastShownAt and a hidden window are still honoured', () => {
  const clock = fixedClock(DAY);
  const scheduler = new LocalGreetingScheduler({ now: clock.now });
  scheduler.restoreLastShownAt(clock.now());
  clock.advance(46 * 60 * 1000);
  assert.equal(scheduler.tick({ visible: true, busy: false }), null, 'a restored recent greeting blocks the cooldown');

  const hidden = new LocalGreetingScheduler({ now: clock.now });
  clock.advance(46 * 60 * 1000);
  assert.equal(hidden.tick({ visible: false, busy: false }), null, 'an invisible window does not greet');
});

test('ACCEPT-02 a backwards clock jump cannot unlock a fresh greeting', () => {
  const clock = fixedClock(DAY);
  const scheduler = new LocalGreetingScheduler({ now: clock.now });
  clock.advance(46 * 60 * 1000);
  assert.ok(scheduler.tick({ visible: true, busy: false }), 'baseline greeting fires');

  // The user corrects the machine clock backwards. The negative idle delta must not re-qualify the greeting.
  clock.set(MORNING);
  assert.equal(scheduler.tick({ visible: true, busy: false }), null, 'a backwards clock must not produce a greeting');
});
