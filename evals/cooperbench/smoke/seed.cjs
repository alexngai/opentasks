/**
 * Seed N ready tasks into the shared daemon (a thin client over the sidecar
 * socket). Part of the cross-container claim smoke — see ../README.md.
 */
const { OpenTasksClient } = require('../../../dist/client/index.js');

(async () => {
  const sock = process.env.OT_SOCK;
  const n = Number(process.env.OT_TASKS || '6');
  const client = new OpenTasksClient({ socketPath: sock, autoConnect: true });
  for (let i = 0; i < n; i++) {
    await client.createNode({
      type: 'task',
      title: `task-${String(i).padStart(2, '0')}`,
      status: 'open',
    });
  }
  client.disconnect();
  console.log(`seeded ${n} tasks via ${sock}`);
})().catch((e) => {
  console.error('seed failed:', e && e.message ? e.message : e);
  process.exit(1);
});
