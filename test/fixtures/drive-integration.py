"""Real CLI entry in isolated foreground PTYs, with only synthetic providers."""
import os,sys,json,pty,select,time,termios,fcntl,struct,signal,subprocess,codecs
from pty_wait import bound,missing
WAIT=45 # A CLI screen can follow provider discovery and a capability probe.

def until(state,marker,timeout=WAIT,retained=False):
 timeout=bound(timeout);deadline=time.monotonic()+timeout
 while time.monotonic()<deadline:
  found=state['output'].find(marker,0 if retained else state['cursor'])
  if found>=0:state['cursor']=max(state['cursor'],found+len(marker));return
  if select.select([state['master']],[],[],0.03)[0]:
   try:data=os.read(state['master'],65536)
   except OSError:break
   if not data:break
   state['output']+=state['decoder'].decode(data)
  elif state['child'].poll() is not None:break
 raise missing(marker,state['output'],timeout)

def remember_provider(state,env):
 # The private fake-provider log is controlled by this test. Resolve ownership
 # before killing the live session leader, not from a recycled process-group ID.
 with open(env['RUNTIME_LOG']) as log:pid=json.loads(log.readlines()[-1])['pid']
 if not isinstance(pid,int) or pid<=1 or os.getpgid(pid)!=state['child'].pid:raise Exception('Fake child is outside the driver-owned process group')
 state.setdefault('providerPids',set()).add(pid)
 return pid

def cleanup_processes(state):
 child=state['child']
 if child.poll() is None:
  # A live leader identifies the isolated group created by this driver.
  try:os.killpg(child.pid,signal.SIGKILL)
  except ProcessLookupError:pass
 else:
  # Darwin can reject killpg on a dead leader's orphaned/revoked-PTY group.
  # Signal only fake child PIDs observed in that group while its leader lived.
  for pid in state.get('providerPids',()):
   try:
    if os.getpgid(pid)!=child.pid:raise Exception('Owned fake child changed its process group')
    os.kill(pid,signal.SIGKILL)
   except ProcessLookupError:pass
 child.wait()

def main():
 # An interrupted test run sends SIGTERM; exiting through finally still kills the sessions this driver created.
 signal.signal(signal.SIGTERM,lambda *_:sys.exit(128+signal.SIGTERM))
 config=json.load(sys.stdin);instances=[]
 def start():
  master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',config.get('rows',44),config.get('columns',170),0,0))
  before=termios.tcgetattr(slave);ack_read,ack_write=os.pipe()
  def own_terminal():os.setsid();fcntl.ioctl(slave,termios.TIOCSCTTY,0)
  # Markers and assertions read plain text; colour has its own tests in tui.test.mjs.
  env=os.environ.copy();env['NO_COLOR']='1';env.update(config['env']);env['CLI_ACK_FD']=str(ack_read)
  child=subprocess.Popen([config['node'],config['runner']]+config.get('args',[]),cwd=config['cwd'],stdin=slave,stdout=slave,stderr=slave,env=env,preexec_fn=own_terminal,pass_fds=(ack_read,))
  os.close(ack_read)
  state={'master':master,'slave':slave,'child':child,'output':'','cursor':0,'before':before,'ack':ack_write,'decoder':codecs.getincrementaldecoder('utf8')(),'preview':[]}
  instances.append(state);return state
 try:
  state=start()
  for action in config['actions']:
   if 'start' in action:state=start()
   if 'append' in action:
    with open(action['append']['path'],'a') as changed:changed.write(action['append']['text'])
   if 'instance' in action:state=instances[action['instance']]
   if 'wait' in action:until(state,action['wait'],action.get('timeout',WAIT))
   if 'signal' in action:os.kill(state['child'].pid,getattr(signal,action['signal']))
   if 'send' in action:os.write(state['master'],action['send'].encode())
   if 'waitPrePidBarrier' in action:until(state,'PID_COMMIT_PAUSED',retained=True)
   if 'waitPostPidCommit' in action:until(state,'PID_COMMIT_DONE',retained=True)
   if 'assertWrapperAlive' in action:
    if state['child'].poll() is not None:raise Exception('Wrapper exited before the driver observed child READY')
   if 'killWrapper' in action:
    remember_provider(state,config['env']);state['child'].kill();state['child'].wait(timeout=bound(20))
   if 'collectPreview' in action:
    until(state,'Enter confirm continuation')
    def body():
     rows=state['output'].rsplit('\x1b[2J\x1b[H',1)[-1].split('\r\n')
     footer=next(i for i,row in enumerate(rows) if 'Enter confirm continuation' in row)
     return [row[1:] for row in rows[2:footer-1]] # Skip the heading, the blank lines around the body and the left margin.
    state['preview']=body()
    for step in range(1000):
     if any('END EXACT PROMPT JSON STRING' in row for row in body()):break
     previous=body();os.write(state['master'],b'\x1b[B');until(state,'Enter confirm continuation')
     current=body()
     if current==previous:break
     # One ↓ moves the review screen by exactly one row; anything else would splice rows from different places.
     if current[:-1]!=previous[1:]:raise Exception('Review screen did not scroll by one row:\n'+json.dumps({'before':previous,'after':current},indent=1))
     state['preview'].append(current[-1])
    else:raise Exception('Preview did not reach its final row')
   if 'assertLiveChild' in action:
    if not config['env'].get('CLI_CHILD_HEARTBEAT'):raise Exception('Crash liveness requires a fake-child heartbeat, not just a PID')
    with open(config['env']['RUNTIME_LOG']) as log:pid=json.loads(log.readline())['pid']
    os.kill(pid,0)
    if config['env'].get('CLI_CHILD_HEARTBEAT'):
     heartbeat=config['env']['CLI_CHILD_HEARTBEAT'];before=None;deadline=time.monotonic()+bound(15)
     while time.monotonic()<deadline:
      try:
       with open(heartbeat) as log:beat=json.load(log)
       if beat['pid']!=pid:raise Exception('Heartbeat belongs to another child')
       if before is None:before=beat['sequence']
       elif beat['sequence']>before:
        state.setdefault('liveChildChecks',[]).append({'pid':pid,'before':before,'after':beat['sequence']});break
      except (FileNotFoundError,json.JSONDecodeError):pass
      time.sleep(0.01)
     else:raise Exception('Fake child heartbeat did not advance independently of the revoked PTY')
  results=[]
  for state in instances:
   if state['child'].poll() is None:
    until(state,'CLI_DONE');after=termios.tcgetattr(state['slave']);alive=state['child'].poll() is None
    os.write(state['ack'],b'T');os.close(state['ack']);state['ack']=None;state['child'].wait(timeout=bound(20))
    results.append({'output':state['output'],'code':state['child'].returncode,'restored':after==state['before'],'sampledWhileAlive':alive,'preview':state['preview'],'liveChildChecks':state.get('liveChildChecks',[])})
   else:results.append({'output':state['output'],'code':state['child'].returncode,'liveChildChecks':state.get('liveChildChecks',[])})
  print(json.dumps(results))
 finally:
  cleanup_errors=[]
  for state in instances:
   if state['ack'] is not None:os.close(state['ack'])
   try:cleanup_processes(state)
   except Exception as error:cleanup_errors.append(error)
   finally:os.close(state['master']);os.close(state['slave'])
  if cleanup_errors:raise cleanup_errors[0]
if __name__=='__main__':main()
