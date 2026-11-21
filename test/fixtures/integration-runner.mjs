// Run the actual CLI entry. The ACK keeps the test's PTY leader alive only long
// enough to sample restored termios on macOS; it is never a delivery receipt.
import { readSync, writeSync, readFileSync } from 'node:fs';
process.once('beforeExit',()=>{
 writeSync(1,'\nCLI_DONE\n');
 if(process.env.CLI_ACK_FD)readSync(Number(process.env.CLI_ACK_FD),Buffer.alloc(1),0,1,null);
});
if(process.env.CLI_CRASH_POINT==='spawn-before-pid') {
 const {TransferJournal}=await import('../../dist/transfer-journal.js');
 TransferJournal.prototype.spawned=function() {
  const until=Date.now()+5000;
  while(Date.now()<until) {
   try {if(readFileSync(process.env.RUNTIME_LOG,'utf8').trim())process.kill(process.pid,'SIGKILL');} catch {}
   Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
  }
  throw new Error('Fake child failed to start');
 };
}
await import('../../dist/cli.js');
