#!/usr/bin/env node
// Offline provider stand-in. Reads no native settings, histories or network.
import { appendFileSync, writeFileSync } from 'node:fs';
const args=process.argv.slice(2);
const opencode=process.env.RUNTIME_TARGET==='opencode';
const claude=process.env.RUNTIME_TARGET==='claude';
if(args.includes('--version'))console.log(opencode?(process.env.OPENCODE_FAKE_VERSION||'1.19.6'):claude?'2.1.330 (Claude Code)':'codex-cli 0.171.0');
else if(args.includes('--help')) {
 console.log(opencode?(process.env.OPENCODE_FAKE_HELP||'opencode [project]\n--session  session id\n--prompt  prompt to use'):claude?'Usage: claude [options] [command] [prompt]\n-r, --resume [value]':args[0]==='resume'
 ? 'Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]\n-C, --cd <DIR>'
 : 'Usage: codex [OPTIONS] [PROMPT]\n-C, --cd <DIR>');
 if(opencode&&process.env.OPENCODE_FAKE_DELETE_DURING_HELP){const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(process.env.OPENCODE_DB);db.exec('DELETE FROM session');db.close();}
}
else {
 const scenario=process.env.RUNTIME_SCENARIO;
 if(opencode&&args.some(arg=>arg.startsWith('--session='))) {
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(process.env.OPENCODE_DB);const id=args.find(arg=>arg.startsWith('--session=')).slice('--session='.length);
  const exists=db.prepare('SELECT id FROM session WHERE id=?').get(id);
  if(!exists){db.close();console.error('SYNTHETIC NATIVE SESSION MISSING');process.exit(1);}
  if(process.env.OPENCODE_FAKE_DELETE_AFTER_VALIDATE){db.prepare('DELETE FROM session WHERE id=?').run(id);db.close();appendFileSync(process.env.RUNTIME_LOG,JSON.stringify({args,cwd:process.cwd(),deleted:true,created:false,autoRequest:false})+'\n');console.error('SYNTHETIC NATIVE SESSION DELETED: home, no automatic request');process.exit(1);}
  db.close();
 }
 if(process.env.CLI_CHILD_HEARTBEAT){
  // Keep a verifiable live child even after macOS revokes its terminal descriptors.
  process.stdin.on('error',()=>{});
  let sequence=0;
  setInterval(()=>writeFileSync(process.env.CLI_CHILD_HEARTBEAT,JSON.stringify({pid:process.pid,sequence:sequence++})),20);
 }
 appendFileSync(process.env.RUNTIME_LOG,JSON.stringify({pid:process.pid,args,cwd:process.cwd(),tty:[process.stdin.isTTY,process.stdout.isTTY,process.stderr.isTTY]})+'\n');
 console.log('CHILD '+JSON.stringify({tty:[process.stdin.isTTY,process.stdout.isTTY,process.stderr.isTTY],raw:process.stdin.isRaw===true}));
 if(scenario==='auth'){console.error('SYNTHETIC AUTH REFUSAL: authenticate independently');process.exit(1);}
 else if(scenario==='exit7'||scenario==='overlap')process.exit(7);
 else if(scenario==='self-signal')process.kill(process.pid,'SIGTERM');
 else {
  if(scenario==='raw'){process.stdin.setRawMode(true);process.stdout.write('\x1b[?25l');}
  process.on('SIGWINCH',()=>console.log('RESIZED'));
  process.stdin.on('data',data=>{
   console.log('INPUT '+JSON.stringify(data.toString()));
   if(data.toString().includes('quit'))process.exit(0);
  });
  // Delay this test milestone to expose parent-death scheduling before READY.
  if(process.env.RUNTIME_READY_DELAY_MS)await new Promise(resolve=>setTimeout(resolve,Number(process.env.RUNTIME_READY_DELAY_MS)));
  console.log('READY');
 }
}
