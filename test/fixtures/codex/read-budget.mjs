// Observe actual native FileHandle reads; private SQLite recovery stays outside the source tree.
import fs from 'node:fs';
import { resolve, relative } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const root = process.env.AGENTSWITCH_FIXTURE_ROOT;
const original = fs.promises.open;
const reads = [];
fs.promises.open = async (path, ...options) => {
  const handle = await original(path, ...options);
  if (resolve(String(path)).startsWith(`${root}/`)) {
    const read = handle.read.bind(handle);
    handle.read = async (buffer, offset, length, position) => {
      const result = await read(buffer, offset, length, position);
      reads.push({path:relative(root,String(path)),requested:length,bytes:result.bytesRead});
      return result;
    };
  }
  return handle;
};
if (process.env.AGENTSWITCH_UNSTABLE_METADATA === '1') {
  const stat = fs.promises.stat;
  let sequence = 0;
  fs.promises.stat = async (path, options) => {
    const info = await stat(path, options);
    if (path === `${root}/state_5.sqlite`) info.mtimeNs += BigInt(++sequence);
    return info;
  };
}
syncBuiltinESMExports();
const { CodexSessionAdapter } = await import('../../../dist/adapters/codex.js');
const diagnostics = [];
const adapter = new CodexSessionAdapter({root,limits:JSON.parse(process.env.AGENTSWITCH_READ_LIMITS),onDiagnostic:d=>diagnostics.push(d)});
const result = process.env.AGENTSWITCH_READ_ID ? await adapter.readHistoryDetailed(process.env.AGENTSWITCH_READ_ID) : await adapter.discover();
process.stdout.write(JSON.stringify({result,diagnostics,reads}));
