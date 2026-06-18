/**
 * One agent draining the shared queue via atomic claim_next, from its own
 * container, against the sidecar daemon. Writes the ids it claimed to a
 * per-agent file on the shared volume so check.cjs can verify exactly-once.
 *
 * The point: this runs in a DIFFERENT container than the daemon (and than the
 * other agent), so a clean drain proves the claim serializes across the
 * container boundary through the one shared daemon.
 */
const { OpenTasksClient } = require('../../../dist/client/index.js');
const { writeFileSync } = require('node:fs');

(async () => {
  const sock = process.env.OT_SOCK;
  const agent = process.env.OT_AGENT_ID || 'agent';
  const out = `/srv/ot/claimed-${agent}.txt`;
  const client = new OpenTasksClient({ socketPath: sock, autoConnect: true });

  const claimed = [];
  let misses = 0;
  // Drain until the queue looks empty (a few consecutive empties to absorb
  // races with the other agent).
  while (misses < 5) {
    const res = await client.task({ claimNext: { agentId: agent } });
    // client.task() wraps the outcome: { success, data: { claimed, nodeId, ... } }
    const r = (res && res.data) || res || {};
    if (r.claimed && r.nodeId) {
      claimed.push(r.nodeId);
      misses = 0;
    } else {
      misses++;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  // Always write the file (even if empty) so check.cjs can confirm this agent
  // actually connected and ran.
  writeFileSync(out, claimed.map((id) => `${agent} ${id}`).join('\n') + (claimed.length ? '\n' : ''));
  client.disconnect();
  console.log(`${agent} claimed ${claimed.length}: ${claimed.join(', ')}`);
})().catch((e) => {
  console.error('drain failed:', e && e.message ? e.message : e);
  process.exit(1);
});
