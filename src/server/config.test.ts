import assert from 'node:assert/strict';
import test from 'node:test';
import { clampAutoDeployInterval } from './config.js';

test('automatic scan/deploy cadence stays between five and ten minutes', () => {
  assert.equal(clampAutoDeployInterval(60_000), 5 * 60_000);
  assert.equal(clampAutoDeployInterval(7 * 60_000), 7 * 60_000);
  assert.equal(clampAutoDeployInterval(20 * 60_000), 10 * 60_000);
  assert.equal(clampAutoDeployInterval(5 * 60_000), 5 * 60_000);
  assert.equal(clampAutoDeployInterval(Number.NaN), 5 * 60_000, 'the default cadence is five minutes');
});

test('runtime and risk configuration reject live mode, invalid intervals, secret URLs, and nonfinite controls', async () => {
  const {defaultSettings,loadRuntimeConfig,parseSettings,settingsPatch}=await import('./config.js');
  for(const env of [{TRADING_MODE:'live'},{POLL_INTERVAL_MS:'NaN'},{PORT:'0'},{ARKHAM_API_BASE:'http://bad.test'},{ARKHAM_API_BASE:'https://user:secret@example.com'}]) assert.throws(()=>loadRuntimeConfig(env));
  assert.equal(loadRuntimeConfig({}).host,'127.0.0.1');assert.equal(defaultSettings.paused,true);
  assert.throws(()=>parseSettings({...defaultSettings,risk:{...defaultSettings.risk,slippageBps:NaN}}));
  assert.throws(()=>settingsPatch.parse({risk:{unknownControl:1}}));
});
