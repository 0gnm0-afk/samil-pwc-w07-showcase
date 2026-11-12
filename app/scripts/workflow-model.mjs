import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const decode = text => text.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&amp;/g,'&');
const attrs = text => Object.fromEntries([...text.matchAll(/([\w:]+)="([^"]*)"/g)].map(m => [m[1],decode(m[2])]));
export function extractWorkflow(xml) {
  const lanes = [...xml.matchAll(/<bpmn:lane\b([^>]*)>([\s\S]*?)<\/bpmn:lane>/g)].map(m => ({
    ...attrs(m[1]),nodes:[...m[2].matchAll(/<bpmn:flowNodeRef>(.*?)<\/bpmn:flowNodeRef>/g)].map(r => r[1])
  }));
  const nodes = [...xml.matchAll(/<bpmn:(userTask|serviceTask|exclusiveGateway|parallelGateway|startEvent|endEvent|boundaryEvent)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/bpmn:\1>)/g)].map(m => {
    const a = attrs(m[2]);
    return {id:a.id,type:m[1],name:a.name||m[1],lane:lanes.find(l => l.nodes.includes(a.id))?.name,
      description:decode(m[3]?.match(/<bpmn:documentation>([\s\S]*?)<\/bpmn:documentation>/)?.[1]||'')};
  });
  const flows = [...xml.matchAll(/<bpmn:sequenceFlow\b([^>]*?)(?:\/>|>([\s\S]*?)<\/bpmn:sequenceFlow>)/g)].map(m => {
    const a = attrs(m[1]);
    return {id:a.id,from:a.sourceRef,to:a.targetRef,condition:a.name||decode(m[2]?.match(/<bpmn:conditionExpression[^>]*>(.*?)<\//s)?.[1]||'')};
  });
  for (const f of flows) if (!nodes.some(n => n.id===f.from)||!nodes.some(n => n.id===f.to)) throw Error(`BPMN 연결 오류 ${f.id}`);
  if (nodes.some(n => !n.lane)) throw Error('BPMN 담당 레인 누락');
  return {version:createHash('sha256').update(xml.replace(/\r\n/g,'\n')).digest('hex'),nodes,flows};
}
export function generateWorkflow() {
  const model=extractWorkflow(readFileSync(new URL('../../작업/W07_개선.bpmn',import.meta.url),'utf8'));
  writeFileSync(new URL('../data/workflow.json',import.meta.url),JSON.stringify(model,null,2)+'\n');
  return model;
}
if (process.argv[1]===fileURLToPath(import.meta.url)) generateWorkflow();
