"""Real CLI entry in isolated foreground PTYs, with only synthetic providers."""
import os,sys,json,pty,select,time,termios,fcntl,struct,signal,subprocess,codecs

def main():
 config=json.load(sys.stdin);instances=[]
 def start():
  master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',config.get('rows',44),config.get('columns',170),0,0))
  before=termios.tcgetattr(slave);ack_read,ack_write=os.pipe()
  def own_terminal():os.setsid();fcntl.ioctl(slave,termios.TIOCSCTTY,0)
  env=os.environ.copy();env.update(config['env']);env['CLI_ACK_FD']=str(ack_read)
  child=subprocess.Popen([config['node'],config['runner']]+config.get('args',[]),cwd=config['cwd'],stdin=slave,stdout=slave,stderr=slave,env=env,preexec_fn=own_terminal,pass_fds=(ack_read,))
  os.close(ack_read)
  state={'master':master,'slave':slave,'child':child,'output':'','cursor':0,'before':before,'ack':ack_write,'decoder':codecs.getincrementaldecoder('utf8')(),'preview':[]}
  instances.append(state);return state
 def until(state,marker,timeout=15):
  deadline=time.monotonic()+timeout
  while time.monotonic()<deadline:
   found=state['output'].find(marker,state['cursor'])
   if found>=0:state['cursor']=found+len(marker);return
   if select.select([state['master']],[],[],0.03)[0]:
    try:data=os.read(state['master'],65536)
    except OSError:break
    if not data:break
    state['output']+=state['decoder'].decode(data)
   elif state['child'].poll() is not None:break
  raise Exception('Missing '+repr(marker)+'; output='+repr(state['output']))
 try:
  state=start()
  for action in config['actions']:
   if 'start' in action:state=start()
   if 'append' in action:
    with open(action['append']['path'],'a') as changed:changed.write(action['append']['text'])
   if 'instance' in action:state=instances[action['instance']]
   if 'wait' in action:until(state,action['wait'])
   if 'send' in action:os.write(state['master'],action['send'].encode())
   if 'waitPrePidBarrier' in action:
    if 'PID_COMMIT_PAUSED' not in state['output']:until(state,'PID_COMMIT_PAUSED')
   if 'assertWrapperAlive' in action:
    if state['child'].poll() is not None:raise Exception('Wrapper exited before the driver observed child READY')
   if 'killWrapper' in action:state['child'].kill();state['child'].wait(timeout=5)
   if 'collectPreview' in action:
    until(state,'Enter confirm continuation')
    def body():return state['output'].rsplit('\x1b[2J\x1b[H',1)[-1].split('\r\n')[4:4+config.get('rows',44)-8]
    state['preview']=body()
    for step in range(1000):
     if any('END EXACT PROMPT JSON STRING' in row for row in body()):break
     previous=body();os.write(state['master'],b'\x1b[B');until(state,'Enter confirm continuation')
     current=body()
     if current==previous:break
     state['preview'].append(current[-1])
    else:raise Exception('Preview did not reach its final row')
   if 'assertLiveChild' in action:
    with open(config['env']['RUNTIME_LOG']) as log:pid=json.loads(log.readline())['pid']
    os.kill(pid,0)
    if config['env'].get('CLI_CHILD_HEARTBEAT'):
     heartbeat=config['env']['CLI_CHILD_HEARTBEAT'];before=None;deadline=time.monotonic()+5
     while time.monotonic()<deadline:
      try:
       with open(heartbeat) as log:beat=json.load(log)
       if beat['pid']!=pid:raise Exception('Heartbeat belongs to another child')
       if before is None:before=beat['sequence']
       elif beat['sequence']>before:break
      except (FileNotFoundError,json.JSONDecodeError):pass
      time.sleep(0.01)
     else:raise Exception('Fake child heartbeat did not advance independently of the revoked PTY')
  results=[]
  for state in instances:
   if state['child'].poll() is None:
    until(state,'CLI_DONE');after=termios.tcgetattr(state['slave']);alive=state['child'].poll() is None
    os.write(state['ack'],b'T');os.close(state['ack']);state['ack']=None;state['child'].wait(timeout=5)
    results.append({'output':state['output'],'code':state['child'].returncode,'restored':after==state['before'],'sampledWhileAlive':alive,'preview':state['preview']})
   else:results.append({'output':state['output'],'code':state['child'].returncode})
  print(json.dumps(results))
 finally:
  for state in instances:
   if state['ack'] is not None:os.close(state['ack'])
   try:os.killpg(state['child'].pid,signal.SIGKILL)
   except ProcessLookupError:pass
   state['child'].wait();os.close(state['master']);os.close(state['slave'])
if __name__=='__main__':main()
