// Run the actual CLI entry. The ACK keeps the test's PTY leader alive only long
// enough to sample restored termios on macOS; it is never a delivery receipt.
import { readSync, writeSync } from 'node:fs';
process.once('beforeExit',()=>{
 writeSync(1,'\nCLI_DONE\n');
 if(process.env.CLI_ACK_FD)readSync(Number(process.env.CLI_ACK_FD),Buffer.alloc(1),0,1,null);
});
if(process.env.CLI_CRASH_POINT==='spawn-before-pid') {
 const {TransferJournal}=await import('../../dist/transfer-journal.js');
 TransferJournal.prototype.spawned=function() {
  // Stay before the durable PID write while the driver observes the child's
  // READY on a live controlling terminal, then kills this wrapper explicitly.
  writeSync(1,'\nPID_COMMIT_PAUSED\n');
  if(!process.env.CLI_ACK_FD)throw new Error('Missing crash-test barrier descriptor');
  readSync(Number(process.env.CLI_ACK_FD),Buffer.alloc(1),0,1,null);
  throw new Error('Crash-test barrier unexpectedly released');
 };
}
await import(process.env.CLI_ENTRY_MODULE??'../../dist/cli.js');
