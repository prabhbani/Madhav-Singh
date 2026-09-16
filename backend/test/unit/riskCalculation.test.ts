import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CODE_POLICY,
  PRIORITY_BANDS,
  RANKING_WEIGHTS,
  baselineRatioSeverity,
  clamp,
  flagSeverity,
  ratioSeverity,
  sigmoidSeverity,
} from '../../src/recommendations/policy.js';
import {
  DETECTOR_POLICY,
  SEVERITY_ORDER,
  higherSeverity,
  ladderThreshold,
  lowerSeverity,
  severityFromLadder,
  type SeverityLadder,
} from '../../src/alerts/policy.js';
import type { AlertSeverity, AlertType } from '../../src/alerts/types.js';

describe('severity functions', () => {
  it('keeps every output inside the unit interval', () => {
    const inputs = [-1e9, -1, 0, 0.5, 1, 7, 1_000, 1e9, Number.MAX_SAFE_INTEGER];
    for (const value of inputs) {
      for (const severity of [
        ratioSeverity(value, 15),
        sigmoidSeverity(value, 21, 7),
        baselineRatioSeverity(value, 40),
        clamp(value),
      ]) {
        assert.ok(severity >= 0 && severity <= 1, `severity ${severity} from ${value} left [0,1]`);
      }
    }
  });

  it('returns a defined value for a non-finite input rather than propagating it', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const severity of [ratioSeverity(value, 15), sigmoidSeverity(value, 21, 7), clamp(value)]) {
        assert.ok(Number.isFinite(severity), `non-finite input ${value} produced ${severity}`);
      }
    }
  });

  it('scales a count linearly up to its threshold, then saturates', () => {
    assert.equal(ratioSeverity(0, 15), 0);
    assert.equal(ratioSeverity(15, 15), 1);
    assert.ok(Math.abs(ratioSeverity(7.5, 15) - 0.5) < 1e-9);
    // An extremely large project saturates rather than ranking absurdly high.
    assert.equal(ratioSeverity(12_400, 15), 1);
  });

  it('treats a zero threshold as "any value is material" without dividing by zero', () => {
    assert.equal(ratioSeverity(0, 0), 0);
    assert.equal(ratioSeverity(1, 0), 1);
  });

  it('reaches one half at the tolerance point of an ageing ramp', () => {
    assert.ok(Math.abs(sigmoidSeverity(21, 21, 7) - 0.5) < 1e-9);
    assert.ok(sigmoidSeverity(40, 21, 7) > 0.9, 'well past tolerance is high');
    assert.ok(sigmoidSeverity(5, 21, 7) < 0.1, 'well short of tolerance is low');
  });

  it('is monotonic in the measured value', () => {
    let previous = -1;
    for (let days = 0; days <= 200; days += 5) {
      const severity = sigmoidSeverity(days, 45, 15);
      assert.ok(severity >= previous, `severity fell at ${days} days`);
      previous = severity;
    }
  });

  it('measures stage age against its baseline, not a universal day count', () => {
    assert.equal(baselineRatioSeverity(40, 40), 0, 'at baseline there is no excess');
    assert.equal(baselineRatioSeverity(80, 40), 1, 'double the baseline saturates');
    assert.ok(Math.abs(baselineRatioSeverity(60, 40) - 0.5) < 1e-9);
    // A missing or zero baseline yields no signal rather than an infinite one.
    assert.equal(baselineRatioSeverity(90, 0), 0);
  });

  it('reserves a hard one for a governed flag', () => {
    assert.equal(flagSeverity(true), 1);
    assert.equal(flagSeverity(false), 0);
  });
});

describe('recommendation ranking policy', () => {
  it('weights sum to one, so a score stays comparable across projects', () => {
    const total = Object.values(RANKING_WEIGHTS).reduce((sum, weight) => sum + weight, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `weights sum to ${total}`);
  });

  it('orders priority bands downwards with no gap and no overlap', () => {
    const minimums = PRIORITY_BANDS.map((band) => band.min);
    for (let index = 1; index < minimums.length; index += 1) {
      assert.ok(minimums[index]! < minimums[index - 1]!, 'bands must descend');
    }
    assert.equal(minimums[minimums.length - 1], 0, 'the lowest band must catch every score');
  });

  it('keeps every code policy inside its documented range', () => {
    for (const [code, policy] of Object.entries(CODE_POLICY)) {
      assert.ok(policy.weight > 0 && policy.weight <= 1, `${code} weight out of range`);
      assert.ok(policy.slaDays > 0 && policy.slaDays <= 90, `${code} SLA out of range`);
      assert.ok(policy.threshold >= 0, `${code} threshold is negative`);
    }
  });

  it('gives the governed hard stop the highest weight and the shortest window', () => {
    const hardStops = Object.entries(CODE_POLICY).filter(([, policy]) => policy.hardStop);
    assert.equal(hardStops.length, 1, 'exactly one hard stop is defined');
    const [code, policy] = hardStops[0]!;
    assert.equal(code, 'ACTIVE_STAY_ORDER');
    assert.equal(policy.weight, 1);
    for (const [other, otherPolicy] of Object.entries(CODE_POLICY)) {
      if (other === code) continue;
      assert.ok(otherPolicy.slaDays >= policy.slaDays, `${other} should not act faster than a hard stop`);
    }
  });

  it('cannot produce a score outside the unit interval at the extremes', () => {
    const score = (components: number) =>
      RANKING_WEIGHTS.evidenceSeverity * components +
      RANKING_WEIGHTS.modelLinkage * components +
      RANKING_WEIGHTS.urgency * components +
      RANKING_WEIGHTS.policyWeight * components +
      RANKING_WEIGHTS.predictedRisk * components +
      RANKING_WEIGHTS.historicalSupport * components;
    assert.equal(score(0), 0);
    assert.ok(Math.abs(score(1) - 1) < 1e-9);
  });
});

describe('alert severity ladders', () => {
  const ladders = Object.entries(DETECTOR_POLICY) as Array<[AlertType, { ladder: SeverityLadder; materialDelta: number }]>;

  it('orders every ascending ladder upwards and every descending ladder downwards', () => {
    for (const [type, policy] of ladders) {
      const rungs = [policy.ladder.INFO, policy.ladder.WARNING, policy.ladder.HIGH, policy.ladder.CRITICAL];
      for (let index = 1; index < rungs.length; index += 1) {
        if (policy.ladder.direction === 'ASCENDING') {
          assert.ok(rungs[index]! >= rungs[index - 1]!, `${type} ascending ladder is out of order`);
        } else {
          assert.ok(rungs[index]! <= rungs[index - 1]!, `${type} descending ladder is out of order`);
        }
      }
    }
  });

  it('gives every detector a positive material delta, so history is not spammed', () => {
    for (const [type, policy] of ladders) {
      assert.ok(policy.materialDelta > 0, `${type} has no material delta`);
    }
  });

  it('returns nothing below the lowest rung rather than a floor severity', () => {
    const ascending: SeverityLadder = { direction: 'ASCENDING', INFO: 3, WARNING: 8, HIGH: 15, CRITICAL: 25 };
    assert.equal(severityFromLadder(2, ascending), null);
    assert.equal(severityFromLadder(3, ascending), 'INFO');
    assert.equal(severityFromLadder(7, ascending), 'INFO');
    assert.equal(severityFromLadder(8, ascending), 'WARNING');
    assert.equal(severityFromLadder(15, ascending), 'HIGH');
    assert.equal(severityFromLadder(1_000_000, ascending), 'CRITICAL');
  });

  it('reads a descending ladder from the other end', () => {
    const descending: SeverityLadder = { direction: 'DESCENDING', INFO: 14, WARNING: 7, HIGH: 3, CRITICAL: 1 };
    assert.equal(severityFromLadder(30, descending), null);
    assert.equal(severityFromLadder(14, descending), 'INFO');
    assert.equal(severityFromLadder(5, descending), 'WARNING');
    assert.equal(severityFromLadder(2, descending), 'HIGH');
    assert.equal(severityFromLadder(0, descending), 'CRITICAL');
    assert.equal(severityFromLadder(-5, descending), 'CRITICAL', 'an overdue value stays at the top rung');
  });

  it('refuses a non-finite measurement rather than classifying it', () => {
    const ascending: SeverityLadder = { direction: 'ASCENDING', INFO: 1, WARNING: 2, HIGH: 4, CRITICAL: 7 };
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const result = severityFromLadder(value, ascending);
      assert.ok(result === null || SEVERITY_ORDER[result] >= 0, `unexpected result for ${value}`);
    }
    assert.equal(severityFromLadder(Number.NaN, ascending), null);
  });

  it('reports the rung a severity crossed, for the trigger expression', () => {
    const ladder = DETECTOR_POLICY.MILESTONE_OVERDUE.ladder;
    assert.equal(ladderThreshold(ladder, 'HIGH'), 21);
    assert.equal(ladderThreshold(ladder, 'CRITICAL'), 45);
  });

  it('compares severities consistently in both directions', () => {
    const order: AlertSeverity[] = ['INFO', 'WARNING', 'HIGH', 'CRITICAL'];
    for (const left of order) {
      for (const right of order) {
        const higher = higherSeverity(left, right);
        const lower = lowerSeverity(left, right);
        assert.ok(SEVERITY_ORDER[higher] >= SEVERITY_ORDER[left]);
        assert.ok(SEVERITY_ORDER[higher] >= SEVERITY_ORDER[right]);
        assert.ok(SEVERITY_ORDER[lower] <= SEVERITY_ORDER[left]);
        assert.ok(SEVERITY_ORDER[lower] <= SEVERITY_ORDER[right]);
      }
    }
  });
});
