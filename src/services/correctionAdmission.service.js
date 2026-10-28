'use strict';
// Process-local transport backpressure. Durable submission leases/recovery stay
// in the existing assessment worker. No source/scoring circuit is consulted.
function createAdmission({limit=4,queueLimit=64}={}) {
  let active=0;const queue=[];
  const error=()=>Object.assign(new Error('Correction capacity is temporarily unavailable.'),{code:'AI_PROVIDER_UNAVAILABLE'});
  function acquire(timeoutMs,signal){return new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(error());
    let timer;
    const item={grant(){clearTimeout(timer);signal?.removeEventListener('abort',cancel);active++;
      let released=false;resolve(()=>{if(released)return;released=true;active--;queue.shift()?.grant();});}};
    function cancel(){const i=queue.indexOf(item);if(i<0)return;queue.splice(i,1);clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(error());}
    if(active<limit){item.grant();return;}
    if(queue.length>=queueLimit){reject(error());return;}
    queue.push(item);timer=setTimeout(cancel,Math.max(1,timeoutMs));signal?.addEventListener('abort',cancel,{once:true});
  });}
  return {acquire,snapshot:()=>({active,queued:queue.length,limit,queueLimit})};
}
module.exports={createAdmission,shared:createAdmission()};
