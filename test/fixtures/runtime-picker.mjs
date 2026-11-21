import { createRuntime, createOwnedSessionGuard } from '../../dist/runtime.js';
import { runPicker } from '../../dist/tui/app.js';
import { realpathSync, chmodSync, read, closeSync } from 'node:fs';
const ackFd=Number(process.env.RUNTIME_ACK_FD);
delete process.env.RUNTIME_ACK_FD;
if(!Number.isInteger(ackFd)||ackFd<3)throw Error('Missing terminal-sampling acknowledgement descriptor');
const workspace=realpathSync(process.env.RUNTIME_WORKSPACE);
const source={id:'synthetic',nativeId:'12345678-1234-1234-1234-123456789abc',agent:process.env.RUNTIME_SOURCE||'codex'};
const events=['SIGINT','SIGTERM'];const before=events.map(e=>process.listenerCount(e));
const abort=new AbortController();
let leasedResolve;const leased=new Promise(resolve=>{leasedResolve=resolve;});
const owned=createOwnedSessionGuard();
const guard={check:source=>owned.check(source),acquire:source=>{
 const release=owned.acquire(source);leasedResolve();console.log('LEASE '+owned.check(source));
 if(process.env.RUNTIME_SCENARIO==='spawn-error')chmodSync(process.env.RUNTIME_EXECUTABLE,0o600);
 if(process.env.RUNTIME_SCENARIO==='cancel-acquire')abort.abort();
 return ()=>{release();console.log('RELEASE '+owned.check(source));};
}};
const runtime=createRuntime({guard,executables:{codex:process.env.RUNTIME_EXECUTABLE,claude:process.env.RUNTIME_EXECUTABLE},getSource:async()=>({...source,workspace,nativeResume:'compatible'})});
let calls=0;
try {
 await runPicker({workspace,query:async()=>[{...source,title:'Synthetic runtime source',workspace,updatedAt:'2026-11-21',matches:[]}],
  preview:async()=>[{id:'a',role:'user',text:'Synthetic history',status:'complete'}],
  prepare:request=>runtime.prepare({...request,target:process.env.RUNTIME_TARGET||request.target},{currentRequest:'--literal $(touch sentinel); `echo unsafe` "quotes"',...(process.env.RUNTIME_TARGET==='claude'&&source.agent!=='claude'?{handoff:{prompt:'Historical user context\nCurrent request: --literal $(touch sentinel)',includedItemIds:['a'],omittedItemIds:['b']}}:{})}),
  continue:async plan=>{
   console.log('DISPATCH '+JSON.stringify({raw:process.stdin.isRaw,calls:++calls}));
   let result;
   try{
    if(process.env.RUNTIME_SCENARIO==='overlap'){
     const second=await runtime.prepare({source,target:'codex',workspace:{kind:'source',path:workspace}},{mode:'fresh',handoff:{prompt:'Second synthetic user prompt',includedItemIds:[],omittedItemIds:[]}});
     const first=runtime.launch(plan);await leased;
     try{await runtime.launch(second.plan);console.log('OVERLAP LAUNCHED');}catch(error){console.log('OVERLAP '+error.code);}
     result=await first;
    }else result=await runtime.launch(plan,{signal:abort.signal});
   }catch(error){console.log('EXPECTED_ERROR '+error.code);return;}

   console.log('RESULT '+JSON.stringify(result));
   // A confirmed plan is one shot even after normal exit; delivery is uncertain.
   try{await runtime.launch(plan,{signal:abort.signal});}catch(error){console.log('RETRY '+error.code);}
  }});
 console.log('DONE '+JSON.stringify({before,after:events.map(e=>process.listenerCount(e)),calls,raw:process.stdin.isRaw}));
}catch(error){console.log('ERROR '+error.code+' '+error.message);process.exitCode=1;}

// Keep the controlling session leader alive until the harness samples termios.
// The acknowledgement is private fixture synchronization, never provider input.
await new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>{console.error('Terminal-sampling acknowledgement timed out');process.exit(1);},5000);
 const token=Buffer.alloc(1);
 read(ackFd,token,0,1,null,(error,count)=>{
  clearTimeout(timer);closeSync(ackFd);
  if(error)reject(error);
  else if(count!==1||token[0]!==84)reject(Error('Invalid terminal-sampling acknowledgement'));
  else resolve();
 });
});
