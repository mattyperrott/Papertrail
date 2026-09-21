import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ServerEvent } from '../shared/types.js';
import { parseSettings, runtimeConfig, settingsPatch } from './config.js';
import { PapertrailOrchestrator } from './orchestrator.js';
import { validationGates } from './performance.js';
import { StateStore } from './store.js';

export type ApiOrchestrator = Pick<PapertrailOrchestrator,
  'state' | 'runScan' | 'scanAndDeploy' | 'refreshMarks' | 'updateSettings' | 'toggleTrader' | 'resetSimulation' | 'acknowledgeHalt' | 'reconcile' | 'testWebhook' | 'conditionalResume' | 'emergencyHalt' | 'approvePaperRelease' | 'acknowledgeAlert' | 'on' | 'off'>;

export function createApplication(orchestrator: ApiOrchestrator, store: StateStore) {
  const app = express();
  const clients = new Set<Response>();
  const allowedOrigins = new Set([
    `http://localhost:${runtimeConfig.port}`, `http://127.0.0.1:${runtimeConfig.port}`,
    'http://localhost:5173', 'http://127.0.0.1:5173',
  ]);
  app.disable('x-powered-by');
  app.use('/api', (request, response, next) => {
    let hostname = '';
    try { hostname = new URL(`http://${request.headers.host}`).hostname; } catch { /* deny invalid Host */ }
    const origin = request.get('Origin');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)
      || origin && !allowedOrigins.has(origin)
      || request.get('Sec-Fetch-Site') === 'cross-site') {
      response.status(403).json({ error: 'Local same-origin API access required' });
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !request.is('application/json')) {
      response.status(415).json({ error: 'Control requests require application/json' });
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const id = randomUUID();
      const started = Date.now();
      response.setHeader('X-Request-Id', id);
      response.once('finish', () => console.info(JSON.stringify({
        event: 'api-control', id, method: request.method, path: request.path,
        status: response.statusCode, durationMs: Date.now() - started, at: new Date().toISOString(),
      })));
    }
    next();
  });
  app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)) }));
  app.use(express.json({ limit: '256kb' }));

  app.get('/api/health', (_request, response) => {
    response.status(store.healthy ? 200 : 503).json({
      ok: store.healthy, mode: 'paper', liveEnabled: false,
      paused: orchestrator.state.settings.paused, provider: orchestrator.state.providerStatus,
    });
  });
  app.get('/api/state', (_request, response) => response.json(orchestrator.state));
  app.get('/api/validation', (_request, response) => response.json(validationGates(orchestrator.state.account)));
  app.get('/api/performance', (_request, response) => response.json(orchestrator.state.summary));
  app.get('/api/workers', (_request, response) => response.json(orchestrator.state.account.workerHealth??{}));
  app.get('/api/alerts', (_request, response) => response.json(orchestrator.state.account.alerts??[]));
  app.get('/api/reconciliation', (_request, response) => response.json(orchestrator.state.account.reconciliations??[]));
  app.get('/api/validation/runs', (_request, response) => response.json(orchestrator.state.validationRuns??[]));
  app.get('/api/strategies', (_request, response) => response.json({
    champion:{version:orchestrator.state.account.strategyVersion,sleeve:'champion',selected:orchestrator.state.traders.filter(trader=>trader.selected),performance:orchestrator.state.summary},
    challenger:{sleeve:'challenger',shadowOnly:true,selected:(orchestrator.state.assessments??[]).filter(row=>row.sleeve==='challenger'&&row.eligible)},
  }));
  // `write()` returning false is backpressure, not failure: a 1 MB state event
  // with 500 traders returns false on every push. Destroying the socket on it
  // put every dashboard in a reconnect loop (ERR_INCOMPLETE_CHUNKED_ENCODING).
  // Only a client that has stopped draining for a long time is cut off.
  const send = (client: Response, payload: string) => {
    if (client.writableLength > 16 * 1024 * 1024) { client.destroy(); return; }
    client.write(payload);
  };
  app.get('/api/events', (request, response) => {
    if (clients.size >= 20) { response.status(429).json({ error: 'Too many event streams' }); return; }
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();
    response.write(`event: state\ndata: ${JSON.stringify(orchestrator.state)}\n\n`);
    clients.add(response);
    const heartbeat = setInterval(() => send(response, ': keepalive\n\n'), 20_000);
    request.on('close', () => { clearInterval(heartbeat); clients.delete(response); });
  });

  app.post('/api/scan', (_request, response) => {
    void orchestrator.runScan(false).catch(() => console.error('Background scan failed; inspect provider status'));
    response.status(202).json({ accepted: true });
  });
  app.post('/api/deploy', async (_request, response, next) => {
    try {
      const report = await orchestrator.scanAndDeploy();
      response.json({ state: orchestrator.state, report });
    } catch (error) { next(error); }
  });
  app.post('/api/poll', async (_request, response, next) => {
    try { await orchestrator.refreshMarks(); response.json(orchestrator.state); }
    catch (error) { next(error); }
  });
  app.patch('/api/settings', async (request, response, next) => {
    try {
      const patch = settingsPatch.parse(request.body);
      parseSettings({
        ...orchestrator.state.settings, ...patch,
        risk: { ...orchestrator.state.settings.risk, ...patch.risk },
        scanner: { ...orchestrator.state.settings.scanner, ...patch.scanner },
      });
      await orchestrator.updateSettings(patch);
      response.json(orchestrator.state);
    } catch (error) { next(error); }
  });
  app.patch('/api/traders/:address', async (request, response, next) => {
    try {
      const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/).parse(request.params.address);
      const { selected, name } = z.object({ selected: z.boolean(), name: z.string().trim().min(1).max(80).optional() }).strict().parse(request.body);
      await orchestrator.toggleTrader(address, selected, name);
      response.json(orchestrator.state);
    } catch (error) { next(error); }
  });
  app.post('/api/halt/acknowledge', async (request, response, next) => {
    try {
      const { note } = z.object({ note: z.string().max(500).optional() }).parse(request.body ?? {});
      await orchestrator.acknowledgeHalt(note ?? '');
      response.json(orchestrator.state);
    } catch (error) { next(error); }
  });
  app.post('/api/halt/emergency', async (request, response, next) => {
    try {const {reason}=z.object({reason:z.string().max(500).optional()}).strict().parse(request.body??{});response.json(await orchestrator.emergencyHalt(reason??''));}
    catch(error){next(error);}
  });
  app.post('/api/reconciliation', async (_request, response, next) => {
    try {response.json(await orchestrator.reconcile());}catch(error){next(error);}
  });
  app.post('/api/resume/conditional', async (_request, response, next) => {
    try {response.json(await orchestrator.conditionalResume());}catch(error){next(error);}
  });
  app.post('/api/webhook/test', async (_request, response, next) => {
    try {response.json(await orchestrator.testWebhook());}catch(error){next(error);}
  });
  app.post('/api/release/approve', async (request, response, next) => {
    try {const {note}=z.object({note:z.string().max(500).optional()}).strict().parse(request.body??{});response.json(await orchestrator.approvePaperRelease(note??''));}catch(error){next(error);}
  });
  app.post('/api/alerts/:id/acknowledge', async (request, response, next) => {
    try {response.json(await orchestrator.acknowledgeAlert(z.string().min(1).max(128).parse(request.params.id)));}catch(error){next(error);}
  });

  app.post('/api/simulation/reset', async (_request, response, next) => {
    try { await orchestrator.resetSimulation(); response.json(orchestrator.state); }
    catch (error) { next(error); }
  });

  const publish = (event: ServerEvent) => {
    const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.payload)}\n\n`;
    for (const client of clients) send(client, payload);
  };
  orchestrator.on('event', publish);
  if (process.env.NODE_ENV === 'production') {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const clientDir = path.resolve(currentDir, '../../dist/client');
    app.use(express.static(clientDir));
    app.get('*splat', (_request, response) => response.sendFile(path.join(clientDir, 'index.html')));
  }
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const invalid = error instanceof z.ZodError || error instanceof SyntaxError;
    // The client gets a redacted message; the operator log gets the real one.
    // Without this a 500 left no trace anywhere, which made every failure a guess.
    if (!invalid) console.error(JSON.stringify({
      event: 'api-error', id: response.getHeader('X-Request-Id'), method: request.method, path: request.path,
      message: error instanceof Error ? error.message : String(error), at: new Date().toISOString(),
    }));
    const tooLarge = Boolean(error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large');
    const message = error instanceof z.ZodError
      ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      : invalid ? 'Invalid JSON request' : tooLarge ? 'Request body too large' : 'Operation failed; inspect local service status';
    response.status(invalid ? 400 : tooLarge ? 413 : 500).json({ error: message });
  });
  return {
    app,
    closeStreams: () => {
      orchestrator.off('event', publish);
      for (const client of clients) client.end();
      clients.clear();
    },
  };
}

export async function startServer() {
  const store = new StateStore();
  const orchestrator = new PapertrailOrchestrator(store);
  const { app, closeStreams } = createApplication(orchestrator, store);
  try {
    // No request may race account loading or startup reconciliation.
    await orchestrator.start();
    const server = await new Promise<ReturnType<typeof app.listen>>((resolve, reject) => {
      const listening = app.listen(runtimeConfig.port, runtimeConfig.host, () => resolve(listening));
      listening.once('error', reject);
    });
    console.info(`Papertrail paper API listening on http://${runtimeConfig.host}:${runtimeConfig.port}; live trading disabled`);
    let stopping = false;
    const shutdown = async (drainMs?: number) => {
      if (stopping) return;
      stopping = true;
      // Each step is logged: a shutdown that dies part-way (launchd's SIGKILL,
      // a crash) leaves a stale lock, and the log must show how far it got.
      const step = (name: string) => console.error(JSON.stringify({ event: 'shutdown', step: name, at: new Date().toISOString() }));
      step('signal');
      closeStreams();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        await orchestrator.stop(drainMs);
        step('engine-stopped');
        await store.close();
        step('lock-released');
        await closed;
        step('server-closed');
        // A non-zero exit after a hung job makes launchd (KeepAlive on failure)
        // start a fresh process; a clean exit would leave the service down.
        process.exitCode = orchestrator.isHung ? 1 : 0;
      } catch (error) {
        console.error(JSON.stringify({ event: 'shutdown-error', message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() }));
        console.error('Graceful shutdown failed; verify saved account and lock ownership before restarting');
        // The engine may not have stopped, but the lock must not outlive the process.
        await store.close().catch(() => undefined);
        process.exitCode = 1;
      }
      // Open sockets (the market WebSocket, keep-alive upstream connections)
      // must not keep a finished process alive, and an abandoned job must not
      // keep running beside the next instance of the service.
      setTimeout(() => process.exit(process.exitCode ?? 0), 1000).unref();
    };
    // The job watchdog already restored the last committed state and paused;
    // this is only the exit. Nothing else is left to drain.
    orchestrator.once('hung', () => void shutdown(1000));
    process.once('SIGINT', () => void shutdown());
    process.once('SIGTERM', () => void shutdown());
    return { server, shutdown };
  } catch (error) {
    closeStreams();
    await orchestrator.stop().catch(() => undefined);
    await store.close().catch(() => undefined);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void startServer().catch((error: unknown) => {
    console.error(JSON.stringify({ event: 'startup-error', message: error instanceof Error ? error.message : String(error), at: new Date().toISOString() }));
    console.error('Startup failed; check configuration, state integrity, and state lock ownership. Account history was not reset.');
    process.exitCode = 1;
  });
}
