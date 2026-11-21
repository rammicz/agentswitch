// Guard all process/network entry points before importing the reader.
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import child from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => { throw new Error('Process or network access forbidden in native-reader test'); };
net.connect = net.createConnection = net.Socket.prototype.connect = deny;
http.request = http.get = https.request = https.get = deny;
dns.lookup = dns.resolve = deny;
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) child[name] = deny;
globalThis.fetch = deny;
let metadataStats = 0;
if (process.env.AGENTSWITCH_UNSTABLE_METADATA === '1') {
  const original = fs.promises.stat;
  fs.promises.stat = async (path, options) => {
    const info = await original(path, options);
    if (path === `${process.env.AGENTSWITCH_FIXTURE_ROOT}/state_5.sqlite`) info.mtimeNs += BigInt(++metadataStats);
    return info;
  };
}
syncBuiltinESMExports();
const { CodexSessionAdapter } = await import('../../../dist/adapters/codex.js');
const diagnostics = [];
const reader = new CodexSessionAdapter({root:process.env.AGENTSWITCH_FIXTURE_ROOT,onDiagnostic:d=>diagnostics.push(d)});
const sessions = await reader.discover();
process.stdout.write(JSON.stringify({sessions,history:await reader.readHistoryDetailed(sessions[0].nativeId),diagnostics,metadataStats}));
