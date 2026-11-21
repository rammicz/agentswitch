import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const reads=[],original=fs.promises.open;
fs.promises.open=async(...args)=>{
  const handle=await original(...args),read=handle.read.bind(handle);
  handle.read=async(buffer,offset,length,position)=>{const result=await read(buffer,offset,length,position);reads.push({requested:length,bytes:result.bytesRead});return result;};return handle;
};syncBuiltinESMExports();
const {ClaudeSessionAdapter}=await import('../../../dist/adapters/index.js');
const diagnostics=[],reader=new ClaudeSessionAdapter({root:process.env.AGENTSWITCH_FIXTURE_ROOT,limits:{maxScanBytes:Number(process.env.AGENTSWITCH_BUDGET)},onDiagnostic:d=>diagnostics.push(d)});
process.stdout.write(JSON.stringify({sessions:await reader.discover(),reads,diagnostics}));
