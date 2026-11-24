import { createHash } from 'node:crypto';
import type { HistoryItem } from '../domain.js';

const object = (v:unknown):v is Record<string,unknown> => !!v && typeof v==='object' && !Array.isArray(v);
const validText = (v:unknown):v is string => typeof v==='string' && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff]/u.test(v);
// Unknown top-level keys from newer releases are ignored and never projected; known keys keep their checks.
const modelFields = ['model','input_tokens','cache_read_tokens','output_tokens','thinking','tool_calls'];
const onlyPlainKnown = (row:Record<string,unknown>):boolean => !modelFields.some(key=>Object.hasOwn(row,key));
function request(text:string):string {
  const boundary='\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n';
  const parts=text.split(boundary);
  if(parts.length!==2 || !parts[0]!.startsWith('<USER_REQUEST>\n')) throw Error('invalid-boundary');
  const value=parts[0]!.slice('<USER_REQUEST>\n'.length);
  if(!value || /<\/?(?:USER_REQUEST|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>/.test(value))throw Error('invalid-boundary');
  if(!/^[\s\S]*\n<\/ADDITIONAL_METADATA>(?:\n<USER_SETTINGS_CHANGE>\n[\s\S]*\n<\/USER_SETTINGS_CHANGE>)?$/.test(parts[1]!) ||
     (parts[1]!.match(/<\/ADDITIONAL_METADATA>/g)?.length??0)!==1 ||
     (parts[1]!.match(/<USER_SETTINGS_CHANGE>/g)?.length??0)!==(parts[1]!.match(/<\/USER_SETTINGS_CHANGE>/g)?.length??0))throw Error('invalid-boundary');
  return value;
}

// Tool results may stay RUNNING (asynchronous commands) or end in ERROR/INVALID; they are never projected.
const resultStatuses = new Set(['DONE','RUNNING','ERROR','INVALID']);
function toolCalls(value:unknown):number {
  if(!Array.isArray(value)||!value.length||!value.every(call=>object(call)&&Object.keys(call).every(k=>k==='name'||k==='args')&&
     validText(call.name)&&call.name.length>0&&call.name.length<=200&&object(call.args)))throw Error('unsupported-shape');
  return value.length;
}

/**
 * Complete means the reviewed public-text projection. Tool calls, their results and system messages are excluded
 * steps whose arguments and bodies are never read into items. `lagging` marks a writer that has not yet appended
 * the last step its idle summary counts.
 */
export function parseAgyHistory(text:string,id:string,stepCount:number,limits:{maxItems:number;maxLineBytes:number}):{items:HistoryItem[];excludedSteps:number[];lagging:boolean} {
  if(!text.endsWith('\n'))throw Error('partial-record');
  const lines=text.slice(0,-1).split('\n');
  const lagging=lines.length===stepCount-1;
  if((lines.length!==stepCount&&!lagging) || lines.length>limits.maxItems || !lines.length)throw Error('invalid-ordinal');
  const records=lines.map((line,index)=>{
    if(Buffer.byteLength(line)>limits.maxLineBytes)throw Error('input-limit');
    const row:unknown=JSON.parse(line);
    if(!object(row))throw Error('unsupported-shape');
    if(row.step_index!==index)throw Error('invalid-ordinal');
    if(typeof row.created_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(row.created_at)||!Number.isFinite(Date.parse(row.created_at)))throw Error('unsupported-shape');
    if(row.thinking!==undefined && typeof row.thinking!=='string')throw Error('unsupported-shape');
    for(const key of ['input_tokens','cache_read_tokens','output_tokens'])if(row[key]!==undefined&&(!Number.isSafeInteger(row[key])||Number(row[key])<0))throw Error('unsupported-shape');
    if(row.model!==undefined&&(!validText(row.model)||row.model.length>200))throw Error('unsupported-shape');
    return row;
  });
  const items:HistoryItem[]=[],excludedSteps:number[]=[];
  let previousTime=0,results=0;
  for(let ordinal=0;ordinal<records.length;ordinal++) {
    const row=records[ordinal]!;
    const time=Date.parse(row.created_at as string);
    if(time<previousTime)throw Error('invalid-ordinal');previousTime=time;
    if(results) {
      // The next steps after a tool-call step are its results, one per call.
      if(row.type!=='GENERIC'||row.source!=='MODEL'||!resultStatuses.has(row.status as string)||typeof row.content!=='string'||!onlyPlainKnown(row))throw Error('unsupported-shape');
      excludedSteps.push(ordinal);results--;continue;
    }
    if(row.status!=='DONE')throw Error('unsupported-shape');
    if(row.type==='SYSTEM_MESSAGE'&&row.source==='SYSTEM'&&typeof row.content==='string'&&onlyPlainKnown(row)) {excludedSteps.push(ordinal);continue;}
    let role:HistoryItem['role'],value:string;
    if(row.type==='USER_INPUT'&&row.source==='USER_EXPLICIT'&&validText(row.content)&&row.thinking===undefined&&row.tool_calls===undefined) {
      if(!onlyPlainKnown(row))throw Error('unsupported-shape');
      if(items.length&&items.at(-1)!.role!=='assistant')throw Error('partial-record');
      role='user';value=request(row.content);
    } else if(row.type==='PLANNER_RESPONSE'&&row.source==='MODEL') {
      if(!items.length)throw Error('partial-record');
      if(row.tool_calls!==undefined) {
        results=toolCalls(row.tool_calls);excludedSteps.push(ordinal);
        if(row.content===undefined)continue;
      }
      if(!validText(row.content)||!row.content)throw Error('unsupported-shape');
      role='assistant';value=row.content;
    } else throw Error('unsupported-shape');
    items.push({id:createHash('sha256').update(JSON.stringify([id,row.step_index,role,value])).digest('hex'),role,text:value,status:'complete'});
  }
  if(results||items.at(-1)?.role!=='assistant')throw Error('partial-record');
  return {items,excludedSteps,lagging};
}
