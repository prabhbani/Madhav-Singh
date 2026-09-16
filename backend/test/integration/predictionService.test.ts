import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';

import {
  disconnect,
  resetDatabase,
  seedAccounts,
  seedProjects,
  skipUnlessIntegration,
  startHarness,
  type Harness,
} from '../helpers/integration.js';

/**
 * Prediction service integration.
 *
 * The model service is an untrusted upstream, so these tests stand a stub model
 * host in front of the API and check what happens when it behaves, misbehaves,
 * stalls, redirects, or answers with something the contract does not allow.
 *
 * `ML_SERVICE_URL` is read when the module loads, so the suite covers the
 * rule-only path directly and drives the upstream cases through the service with
 * an explicit endpoint.
 */
describe('prediction service', { skip: skipUnlessIntegration }, () => {
  let harness: Harness;
  let prisma: Awaited<typeof import('../../src/config/prisma.js')>['prisma'];
  let accounts: Awaited<ReturnType<typeof seedAccounts>>;
  let projects: Awaited<ReturnType<typeof seedProjects>>;

  before(async () => {
    ({ prisma } = await import('../../src/config/prisma.js'));
    await resetDatabase();
    accounts = await seedAccounts();
    projects = await seedProjects();
    harness = await startHarness();
  });

  after(async () => {
    await resetDatabase();
    await harness.close();
    await disconnect();
  });

  describe('rule-only path', () => {
    it('returns a labelled fallback when no model service is configured', async () => {
      const response = await harness.call<{
        delayProbability: number;
        riskLevel: string;
        predictionStatus: string;
        confidenceBand: string;
      }>('POST', '/api/v1/predictions', {
        token: accounts.districtOfficer!.token,
        body: { projectId: projects.ludhianaPwd!.id, horizonDays: 90 },
      });
      assert.equal(response.status, 201);
      assert.ok(response.body.delayProbability >= 0 && response.body.delayProbability <= 1);
      assert.ok(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(response.body.riskLevel));
      // Without a model, the response says so rather than implying a model ran.
      assert.equal(response.body.predictionStatus, 'RULE_ONLY_FALLBACK');
      assert.equal(response.body.confidenceBand, 'LOW');
    });

    it('never exposes the stored feature vector', async () => {
      await prisma.prediction.create({
        data: {
          projectId: projects.ludhianaPwd!.id,
          modelVersion: 'synthetic-delay-20260915T173246Z',
          horizonDays: 90,
          delayProbability: 0.82,
          riskLevel: 'HIGH',
          inputSnapshot: { parcel_count: 184, unresolved_record_count: 23, secret_feature: 'internal' },
          explanation: { topRiskFactors: [{ factorCode: 'UNRESOLVED_RECORD_COUNT', relativeContribution: 0.31 }] },
        },
      });

      for (const path of [
        `/api/v1/projects/${projects.ludhianaPwd!.id}/prediction`,
        `/api/v1/projects/${projects.ludhianaPwd!.id}/prediction/history`,
        `/api/v1/projects/${projects.ludhianaPwd!.id}`,
        '/api/v1/risk/high',
      ]) {
        const response = await harness.call(path === '/api/v1/risk/high' ? 'GET' : 'GET', path, {
          token: accounts.districtOfficer!.token,
        });
        const serialized = JSON.stringify(response.body);
        assert.equal(serialized.includes('inputSnapshot'), false, `${path} leaked the snapshot key`);
        assert.equal(serialized.includes('secret_feature'), false, `${path} leaked a feature value`);
      }
    });

    it('still returns the officer-facing explanation', async () => {
      const response = await harness.call<{ explanation: { topRiskFactors: unknown[] } }>(
        'GET',
        `/api/v1/projects/${projects.ludhianaPwd!.id}/prediction`,
        { token: accounts.districtOfficer!.token },
      );
      assert.ok(Array.isArray(response.body.explanation.topRiskFactors));
    });

    it('refuses a prediction for a project outside the caller scope', async () => {
      const response = await harness.call('POST', '/api/v1/predictions', {
        token: accounts.districtOfficer!.token,
        body: { projectId: projects.haryana!.id, horizonDays: 90 },
      });
      assert.equal(response.status, 404, 'an out-of-scope project must look like a missing one');
    });

    it('validates the horizon at the boundary', async () => {
      for (const horizonDays of [0, -1, 400, 1.5]) {
        const response = await harness.call('POST', '/api/v1/predictions', {
          token: accounts.districtOfficer!.token,
          body: { projectId: projects.ludhianaPwd!.id, horizonDays },
        });
        assert.equal(response.status, 400, `horizon ${horizonDays} should be refused`);
      }
    });
  });

  describe('untrusted model upstream', () => {
    let stub: Server;
    let stubUrl: string;
    let behaviour: (request: unknown) => { status: number; body: string; headers?: Record<string, string>; delayMs?: number };

    before(async () => {
      stub = createServer((request, response) => {
        const result = behaviour(request);
        setTimeout(() => {
          response.writeHead(result.status, { 'content-type': 'application/json', ...result.headers });
          response.end(result.body);
        }, result.delayMs ?? 0);
      });
      await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', () => resolve()));
      const address = stub.address();
      if (!address || typeof address === 'string') throw new Error('stub did not bind');
      stubUrl = `http://127.0.0.1:${address.port}`;
    });

    after(async () => {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    });

    /** Calls the service with the stub standing in for the model host. */
    const predictAgainstStub = async () => {
      process.env.ML_SERVICE_URL = stubUrl;
      // The module reads configuration at call time, so a fresh import picks up
      // the stub without restarting the whole application.
      const { predictionService } = await import(`../../src/services/predictionService.js?stub=${Date.now()}`);
      try {
        return await predictionService.predict(projects.ludhianaPwd!.id, 90, new Date());
      } finally {
        delete process.env.ML_SERVICE_URL;
      }
    };

    it('uses a well-formed model response', async () => {
      behaviour = () => ({
        status: 200,
        body: JSON.stringify({
          delayProbability: 0.77,
          expectedDelayDays: 41,
          riskLevel: 'HIGH',
          confidenceBand: 'MEDIUM',
          modelVersion: 'stub-model-1',
        }),
      });
      const result = await predictAgainstStub();
      assert.equal(result.delayProbability, 0.77);
      assert.equal(result.predictionStatus, 'OK');
      assert.equal(result.modelVersion, 'stub-model-1');
    });

    it('discards a field the contract does not name, rather than relaying it', async () => {
      behaviour = () => ({
        status: 200,
        body: JSON.stringify({
          delayProbability: 0.6,
          riskLevel: 'HIGH',
          injectedField: 'should not appear',
          recommendedActions: ['do something dangerous'],
        }),
      });
      const result = await predictAgainstStub();
      assert.equal(JSON.stringify(result).includes('injectedField'), false);
      assert.equal(JSON.stringify(result).includes('do something dangerous'), false);
    });

    it('falls back to the rule path when the model answers out of contract', async () => {
      for (const body of [
        JSON.stringify({ delayProbability: 1.8, riskLevel: 'HIGH' }),
        JSON.stringify({ delayProbability: 0.5, riskLevel: 'CATASTROPHIC' }),
        JSON.stringify({ notAPrediction: true }),
        'not json at all',
      ]) {
        behaviour = () => ({ status: 200, body });
        const result = await predictAgainstStub();
        assert.equal(result.predictionStatus, 'RULE_ONLY_FALLBACK', `should have fallen back for: ${body.slice(0, 40)}`);
      }
    });

    it('falls back when the model errors rather than surfacing the upstream failure', async () => {
      for (const status of [400, 401, 500, 503]) {
        behaviour = () => ({ status, body: JSON.stringify({ error: 'upstream detail that must not leak' }) });
        const result = await predictAgainstStub();
        assert.equal(result.predictionStatus, 'RULE_ONLY_FALLBACK');
        assert.equal(JSON.stringify(result).includes('upstream detail'), false);
      }
    });

    it('refuses to follow a redirect from the model host', async () => {
      behaviour = () => ({
        status: 302,
        body: '',
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      });
      const result = await predictAgainstStub();
      assert.equal(result.predictionStatus, 'RULE_ONLY_FALLBACK');
    });

    it('falls back when the model stalls past the timeout', async () => {
      const { env } = await import('../../src/config/env.js');
      behaviour = () => ({ status: 200, body: JSON.stringify({ delayProbability: 0.5, riskLevel: 'HIGH' }), delayMs: env.ML_SERVICE_TIMEOUT_MS + 500 });
      const started = Date.now();
      const result = await predictAgainstStub();
      assert.equal(result.predictionStatus, 'RULE_ONLY_FALLBACK');
      assert.ok(Date.now() - started < env.ML_SERVICE_TIMEOUT_MS + 2_000, 'the timeout should cut the wait short');
    });

    it('refuses an oversized model response', async () => {
      behaviour = () => ({
        status: 200,
        body: JSON.stringify({ delayProbability: 0.5, riskLevel: 'HIGH', padding: 'x'.repeat(300 * 1024) }),
      });
      const result = await predictAgainstStub();
      assert.equal(result.predictionStatus, 'RULE_ONLY_FALLBACK');
    });
  });
});
