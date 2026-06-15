/**
 * In-process HTTP "emit" collector — the non-idempotent side-effect channel for
 * the synthetic concurrency/continuity eval.
 *
 * Why HTTP and not a file: the whole point of the emit-queue task is that
 * "done-ness" is NOT recoverable from the work dir (that was build-todo's null).
 * An agent calls `./emit <id>` which POSTs here; there is NO file and NO read
 * endpoint, so an agent literally cannot enumerate what's already been emitted —
 * it must coordinate through its arm's mechanism (graph claim / notes / nothing).
 * The harness reads the recorded emits afterward as ground truth (exactly-once).
 */

import * as http from 'node:http';

export interface EmitRecord {
  id: string;
  agent: string;
  /** ms since collector start (monotonic-ish; for race-window analysis). */
  t: number;
}

export interface Collector {
  port: number;
  records: EmitRecord[];
  close: () => Promise<void>;
}

/** Start the collector on an ephemeral loopback port. POST /emit  body: id=..&agent=.. */
export function startCollector(): Promise<Collector> {
  const records: EmitRecord[] = [];
  const start = Date.now();
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/emit') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 1_000_000) req.destroy(); // guard
      });
      req.on('end', () => {
        const params = new URLSearchParams(body);
        const id = (params.get('id') ?? '').trim();
        const agent = (params.get('agent') ?? 'unknown').trim();
        if (id) records.push({ id, agent, t: Date.now() - start });
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      });
      return;
    }
    // No GET/list endpoint by design — done-ness is not observable to agents.
    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        records,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

export interface ExactlyOnceScore {
  m: number;
  distinctEmitted: number;
  exactlyOnce: number;
  missed: number;
  /** ids emitted >1×. */
  duplicatedIds: number;
  /** total redundant emits = Σ(count−1) over duplicated ids — the headline race-incident count. */
  doubleEmits: number;
  totalEmits: number;
  /** correct iff every item emitted exactly once. */
  correct: boolean;
}

/** Ground-truth exactly-once scoring over the collector's records. */
export function scoreExactlyOnce(records: EmitRecord[], items: string[]): ExactlyOnceScore {
  const counts = new Map<string, number>();
  for (const r of records) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
  let exactlyOnce = 0;
  let duplicatedIds = 0;
  let doubleEmits = 0;
  for (const item of items) {
    const c = counts.get(item) ?? 0;
    if (c === 1) exactlyOnce++;
    else if (c > 1) {
      duplicatedIds++;
      doubleEmits += c - 1;
    }
  }
  const distinctEmitted = items.filter((i) => (counts.get(i) ?? 0) > 0).length;
  return {
    m: items.length,
    distinctEmitted,
    exactlyOnce,
    missed: items.length - distinctEmitted,
    duplicatedIds,
    doubleEmits,
    totalEmits: records.length,
    correct: exactlyOnce === items.length && records.length === items.length,
  };
}
