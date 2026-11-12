export const providerRpm = () => {
  const rpm=Number(process.env.W07_NIM_RPM || 40);
  if (!Number.isInteger(rpm) || rpm<1 || rpm>40) throw Object.assign(Error('NIM 속도 설정은 분당 1~40회입니다.'),{code:'CONFIG'});
  return rpm;
};
export function checkNimResponse(response) {
  if(response.ok)return;
  const retry=response.headers?.get('retry-after');
  const wait=retry ? (/^\d+(\.\d+)?$/.test(retry)?Number(retry)*1000:Date.parse(retry)-Date.now()) : 60000;
  throw Object.assign(Error(`NIM HTTP ${response.status}`),{
    code:response.status===429?'AI_RATE_LIMIT':[401,403].includes(response.status)?'AI_AUTH':'AI_HTTP',
    ...(response.status===429?{retryAfterMs:Number.isFinite(wait)?Math.max(1000,wait):60000}:{})
  });
}
export async function withNimSlot(store,{key,priority='guidance',rpm=providerRpm()},call) {
  const slot=await store.nimSlot({key,priority,rpm});
  if(!slot.allowed)throw Object.assign(Error('NVIDIA 무료 호출 속도에 맞춰 순서를 기다리고 있습니다.'),{code:'AI_WAIT',retryAt:slot.retryAt});
  try{return await call();}
  catch(error){
    if(error.code==='AI_RATE_LIMIT'){
      error.retryAt=await store.nimCooldown(error.retryAfterMs||60000);
    }
    throw error;
  }
}
