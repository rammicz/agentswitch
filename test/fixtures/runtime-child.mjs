#!/usr/bin/env node
// Offline provider stand-in. Reads no native settings, histories or network.
import { appendFileSync } from 'node:fs';
const args=process.argv.slice(2);
const claude=process.env.RUNTIME_TARGET==='claude';
if(args.includes('--version'))console.log(claude?'2.1.330 (Claude Code)':'codex-cli 0.171.0');
else if(args.includes('--help'))console.log(claude?'Usage: claude [options] [command] [prompt]\n-r, --resume [value]':args[0]==='resume'
 ? 'Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]\n-C, --cd <DIR>'
 : 'Usage: codex [OPTIONS] [PROMPT]\n-C, --cd <DIR>');
else {
 const scenario=process.env.RUNTIME_SCENARIO;
 appendFileSync(process.env.RUNTIME_LOG,JSON.stringify({args,cwd:process.cwd(),tty:[process.stdin.isTTY,process.stdout.isTTY,process.stderr.isTTY]})+'\n');
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
  console.log('READY');
 }
}
