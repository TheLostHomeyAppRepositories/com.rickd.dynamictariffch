'use strict';

// Warmwasser-Programm per «Auslöser mit Wert»: nach «zurück auf Normal» prüfen, ob der Soll wirklich zurück ist.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EmsRunner } = require('../lib/ems/EmsRunner');
const { ShadowLog } = require('../lib/ems/ShadowLog');
const { PriceFeed } = require('../lib/ems/PriceFeed');
const { PvFeed } = require('../lib/ems/PvFeed');
const { normalizeConfig } = require('../lib/ems/Config');
const { fromLocal } = require('../lib/time');

const at = (h, m = 0) => fromLocal(2026, 11, 13, h, m, 'Europe/Zurich').getTime();
const cheapAt22 = () => Array.from({ length: 96 }, (_, k) => {
  const t = at(0) + k * 900000;
  return { start: t, end: t + 900000, price: t >= at(22) ? 10 : 30 };
});

function make({ readable = true, live = true } = {}) {
  const config = normalizeConfig({
    enabled: true,
    silent: false,
    devices: { meter: { id: 'm' } },
    charger: { enabled: false },
    sgready: { enabled: false },
    dhw: {
      enabled: true,
      live,
      output: 'trigger',
      setpoint: { programC: 52, delayC: 30, normalC: 48 },
      targetSource: readable ? 'device' : 'manual',
      targetId: 'wp',
      targetCapability: 'soll',
      sensorId: 'ww',
      tempCapability: 'temp',
      cheapHours: 2,
      belowTemp: 45,
      startDelayMin: 0,
      minRunMin: 0,
      stopDelayMin: 0,
      skipPv: false,
    },
  });
  const ref = { temp: 40, soll: 48 };
  const sent = [];
  const runner = new EmsRunner({
    getConfig: () => config,
    prices: new PriceFeed(() => null),
    pv: new PvFeed(null, () => {}, { get: async () => ({ slots: [], stale: true }) }),
    inputs: {
      chargerInputs: async () => ({
        gridW: 0, houseW: 300, pvW: 0, batterySoc: null, batteryW: 0, chargerRead: false, chargerConnected: false, chargerPowerW: 0, other: null,
      }),
      consumerStates: async () => new Map(),
      readNumber: async (id, cap) => (cap === 'soll' ? ref.soll : ref.temp),
      readValue: async () => null,
    },
    actuators: {
      charger: async () => ({}),
      program: async () => ({}),
      trigger: async (name, tokens, o) => { sent.push([tokens.kind, tokens.setpoint, o.live]); return { cmd: 'trigger', live: o.live }; },
    },
    shadowLog: new ShadowLog({ get() {}, set() {} }),
    store: null,
  });
  runner.prices = { getSlots: cheapAt22 };
  return { runner, ref, sent };
}

/** Programm starten (Soll 48 -> Gerät meldet 52) und beenden (Warmwasser warm genug): zurück auf Normal wird ausgegeben. */
async function runProgram(runner, ref, sent) {
  await runner.tickCharger(at(22)); // Start: Programm-Soll 52
  assert.deepEqual(sent[0], ['program', 52, true]);
  ref.soll = 52;
  ref.temp = 57;
  await runner.tickCharger(at(22, 1)); // Ende: zurück auf Normal (48)
  assert.deepEqual(sent[1], ['normal', 48, true]);
}

test('Soll-Prüfung: meldet das Gerät den Normalwert wieder, ist es erledigt (ohne Wiederholung)', async () => {
  const { runner, ref, sent } = make();
  await runProgram(runner, ref, sent);
  await runner.tickCharger(at(22, 2));
  assert.equal(runner.dhwCurrent.setpointCheck.state, 'pending', 'Gerät meldet noch 52');
  ref.soll = 48;
  await runner.tickCharger(at(22, 3));
  assert.equal(runner.dhwCurrent.setpointCheck.state, 'ok');
  await runner.tickCharger(at(22, 20));
  assert.equal(runner.dhwCurrent.setpointCheck, null, 'danach keine Prüfung mehr');
  assert.equal(sent.length, 2, 'nichts nochmals gesendet');
});

test('Soll-Prüfung: bleibt der Soll nach 6 Minuten auf 52 °C, wird der Normalwert nochmals ausgegeben (höchstens dreimal), danach «failed»', async () => {
  const { runner, ref, sent } = make();
  await runProgram(runner, ref, sent);
  await runner.tickCharger(at(22, 5));
  assert.equal(sent.length, 2, 'unter 6 Minuten: abwarten');
  await runner.tickCharger(at(22, 8));
  assert.deepEqual(sent[2], ['normal', 48, true]);
  assert.equal(runner.dhwCurrent.setpointCheck.state, 'retry');
  assert.deepEqual([runner.dhwCurrent.setpointCheck.expected, runner.dhwCurrent.setpointCheck.actual], [48, 52]);
  await runner.tickCharger(at(22, 15));
  await runner.tickCharger(at(22, 22));
  assert.equal(sent.length, 5, 'drei Wiederholungen');
  await runner.tickCharger(at(22, 30));
  assert.equal(runner.dhwCurrent.setpointCheck.state, 'failed');
  assert.equal(sent.length, 5, 'danach keine weiteren Befehle');
  ref.soll = 48; // später doch zurück: wieder in Ordnung
  await runner.tickCharger(at(22, 40));
  assert.equal(runner.dhwCurrent.setpointCheck.state, 'ok');
});

test('Soll-Prüfung: ohne lesbaren Soll oder nicht live wird nichts geprüft und nichts wiederholt', async () => {
  const a = make({ readable: false });
  await runProgram(a.runner, a.ref, a.sent);
  await a.runner.tickCharger(at(22, 30));
  assert.equal(a.sent.length, 2);
  assert.ok(!a.runner.dhwCurrent.setpointCheck || a.runner.dhwCurrent.setpointCheck.state === 'pending');
  const b = make({ live: false });
  await b.runner.tickCharger(at(22));
  b.ref.temp = 57;
  await b.runner.tickCharger(at(22, 1));
  await b.runner.tickCharger(at(22, 30));
  assert.ok(b.sent.every((x) => x[2] === false), 'nicht live: nur simuliert');
  assert.equal(b.runner.dhwCurrent.setpointCheck, null);
});

test('Widget: Warnung «Soll nicht zurück» nur bei Wiederholung oder Fehlschlag, nicht bei Abwarten oder Erfolg', () => {
  const { consumersWidget } = require('../lib/WidgetData'); // eslint-disable-line global-require
  const mk = (check) => consumersWidget({
    shadow: {
      deviceExists: true, silent: false, config: { consumers: [], silent: false, dhw: { enabled: true, live: true, flowOn: { id: 'f' } } }, dhw: { on: false, reason: 'x', setpointCheck: check },
    },
    consumerCurrent: [],
    tz: 'Europe/Zurich',
  }).dhw;
  assert.equal(mk(null).setpointWarn, null);
  assert.equal(mk({ state: 'pending', expected: 48, actual: 52, tries: 0 }).setpointWarn, null);
  assert.equal(mk({ state: 'ok', expected: 48, actual: 48, tries: 0 }).setpointWarn, null);
  assert.deepEqual(mk({ state: 'failed', expected: 48, actual: 52, tries: 3 }).setpointWarn, { expected: 48, actual: 52, state: 'failed' });
  assert.equal(mk({ state: 'retry', expected: 48, actual: 52, tries: 1 }).setpointWarn.state, 'retry');
});
