// Official-shaped offline hooks and synthetic native histories. Never a provider call.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const args=process.argv.slice(2),provider=process.env.FAKE_PROVIDER;
let turnId;
if(args.includes('--version'))console.log(provider==='codex'?'codex-cli 0.171.0':'2.1.330 (Claude Code)');
else if(args.includes('--help'))console.log(provider==='claude'?'Usage: claude [options] [command] [prompt]\n--resume [value]':args[0]==='resume'?'Usage: codex resume [OPTIONS] [SESSION_ID] [PROMPT]\n-C, --cd <DIR>':'Usage: codex [OPTIONS] [PROMPT]\n-C, --cd <DIR>'+ (process.env.FAKE_HOOK_MODE==='unsupported'?'':'\n-c, --config <key=value>'));
else {
 const prompt=args.at(-1),cwd=process.cwd(),id=provider==='codex'?(args[0]==='resume'?args.at(-2):'019a0000-0000-7000-8000-000000000004'):'10000000-0000-4000-8000-000000000001';
 const folder=provider==='codex'?join(process.env.CODEX_HOME,'sessions','2026','11','20'):join(process.env.CLAUDE_CONFIG_DIR,'projects','synthetic');mkdirSync(folder,{recursive:true});
 const path=provider==='codex'?join(folder,`rollout-2026-11-20T10-00-00-${id}.jsonl`):join(folder,id+'.jsonl');
 if(provider==='claude') {
  const entry=(uuid,parentUuid,type,content)=>({type,uuid,parentUuid,sessionId:id,cwd,timestamp:'2026-11-20T12:00:00.000Z',version:'2.1.330',message:{role:type,content,...(type==='assistant'?{id:'response-'+uuid}:{})}});
  writeFileSync(path,[entry('echo',null,'user',prompt),entry('b-answer','echo','assistant','B response')].map(JSON.stringify).join('\n')+'\n');
 } else {
  if(!existsSync(path))writeFileSync(path,JSON.stringify({ordinal:0,type:'session_meta',payload:{id,session_id:id,timestamp:'2026-11-20T10:00:00.000Z',cwd,cli_version:'0.171.0',history_mode:'paginated'}})+'\n');
  let ordinal=readFileSync(path,'utf8').trim().split('\n').length;
  turnId='native-turn-'+ordinal;
  for(const [type,text]of [['UserMessage',prompt],['AgentMessage','A response']])appendFileSync(path,JSON.stringify({ordinal:ordinal++,type:'event_msg',payload:{type:'item_completed',thread_id:id,turn_id:process.env.FAKE_HOOK_MODE==='unrelated-output'&&type==='AgentMessage'?'unrelated-turn':process.env.FAKE_HOOK_MODE==='missing-item-turn'?undefined:turnId,item:{id:'native-'+ordinal,type,content:[{type:type==='UserMessage'?'text':'Text',text}]}}})+'\n');
  if(process.env.FAKE_HOOK_MODE==='intervening-user')appendFileSync(path,JSON.stringify({ordinal:ordinal++,type:'event_msg',payload:{type:'item_completed',thread_id:id,turn_id:'intervening-turn',item:{id:'intervening-'+ordinal,type:'UserMessage',content:[{type:'text',text:'Unrelated native user turn'}]}}})+'\n');
 }
 const hooks=args.filter(value=>value.startsWith('hooks.'));
 appendFileSync(process.env.RUNTIME_LOG,JSON.stringify({provider,args,cwd,tty:[process.stdin.isTTY,process.stdout.isTTY,process.stderr.isTTY],locator:!!process.env.AGENTSWITCH_OBSERVER,path})+'\n');
 if(provider==='codex'&&!['disabled','unsupported'].includes(process.env.FAKE_HOOK_MODE)) {
  const submit={session_id:id,turn_id:turnId,cwd,transcript_path:path,hook_event_name:'UserPromptSubmit',prompt,agent_id:null,agent_type:null};
  const stop={session_id:id,turn_id:turnId,cwd,transcript_path:path,hook_event_name:'Stop',stop_hook_active:false};
  const mode=process.env.FAKE_HOOK_MODE;
  if(mode==='wrong-hash')submit.prompt+='changed';
  if(mode==='wrong-turn')stop.turn_id='another-turn';
  if(mode==='background')stop.hook_event_name='SubagentStop';
  if(mode==='failure')stop.hook_event_name='StopFailure';
  if(mode==='wrong-root')submit.transcript_path=stop.transcript_path='/tmp/unrelated-native-transcript';
  for(const event of [submit,...(mode==='submit-only'?[]:[stop,stop])]) {
   const config=hooks.find(value=>value.startsWith('hooks.'+(event.hook_event_name==='UserPromptSubmit'?'UserPromptSubmit':'Stop')+'='));
   if(!config)continue;
   const command=JSON.parse(/command=("(?:\\.|[^"\\])*")/.exec(config)[1]);
   const result=spawnSync(command,{shell:true,env:process.env,input:mode==='malformed'&&event.hook_event_name!=='UserPromptSubmit'?'{':JSON.stringify(event),encoding:'utf8',timeout:6000});
   appendFileSync(process.env.HOOK_LOG,JSON.stringify({status:result.status,stdout:result.stdout,stderr:result.stderr,command})+'\n');
  }
 }
 console.log('READY');process.stdin.on('data',data=>{if(data.toString().includes('quit'))process.exit(0);});
}
