'use strict';
const {EventEmitter}=require('events');
jest.mock('../src/services/imagePreflight.service',()=>({evaluateImage:jest.fn(async()=>({ready:true,checks:[]}))}));
jest.mock('../src/services/gptVisionExact/preflight',()=>({
  pagesFor:jest.fn(async()=>[{bytes:Buffer.from('synthetic'),pageNumber:1}]),checkPages:jest.fn(),
  ui:jest.fn(error=>({sourceReadStatus:error?'FAILED_SERVICE':'PASSED',canSubmit:!error})),
  withSourceCheck:(basic,state)=>({...basic,...state,ready:basic.ready&&state.canSubmit})
}));
const source=require('../src/services/gptVisionExact/preflight'),middleware=require('../src/middlewares/imagePreflight.middleware');
const env={...process.env};
beforeEach(()=>{jest.useFakeTimers();process.env.OCR_SOURCE_MODE='gpt_vision_exact';jest.spyOn(require('../src/utils/logger'),'info').mockImplementation(()=>{});});
afterEach(()=>{jest.useRealTimers();jest.restoreAllMocks();process.env=env;});
function request(){
  const req=Object.assign(new EventEmitter(),{body:{phase:'source',name:'Test',email:'synthetic@example.invalid'},file:{detectedMime:'image/jpeg',buffer:Buffer.from('synthetic')},
    guestContext:{assignment:{_id:'a'},owner:{_id:'t'}},get:()=> 'test-12345678901234567890123456789012'});
  const res=Object.assign(new EventEmitter(),{set:jest.fn(),statusCode:200,writableEnded:false,json:jest.fn(function(v){this.writableEnded=true;return v;}),status:jest.fn(function(n){this.statusCode=n;return this;})});return {req,res};
}
test.each(['deadline','disconnect'])('source request %s reaches provider signal and removes listeners/timer',async kind=>{
  const {req,res}=request();let signal;
  source.checkPages.mockImplementation(async(pages,context,options)=>{signal=options.signal;return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(Error('cancelled'),{code:'OCR_GPT_PROVIDER_NETWORK'})),{once:true}));});
  const pending=middleware.preflightImage(req,res);await jest.advanceTimersByTimeAsync(0);
  expect(signal.aborted).toBe(false);
  if(kind==='deadline'){
    await jest.advanceTimersByTimeAsync(209999);expect(signal.aborted).toBe(false);await jest.advanceTimersByTimeAsync(1);
  }else res.emit('close');
  await pending;expect(signal.aborted).toBe(true);expect(signal.reason).toBe(kind==='deadline'?'source_preflight_deadline':'source_user_cancelled');
  if(kind==='deadline')expect(res.json.mock.calls[0][0].data).toMatchObject({ready:false,canSubmit:false,sourceReadStatus:'FAILED_SERVICE'});
  else expect(res.json).not.toHaveBeenCalled();
  expect(jest.getTimerCount()).toBe(0);expect(req.listenerCount('aborted')).toBe(0);expect(res.listenerCount('close')).toBe(0);
});
