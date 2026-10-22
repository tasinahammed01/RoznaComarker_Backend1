'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),vm=require('vm');
const {validateOcrConfiguration}=require('../src/config/ocr');
const {mode}=require('../src/services/hybridSource/contract');
let directory,credentials;
const configured=()=>({NODE_ENV:'development',PORT:'5000',OCR_SOURCE_MODE:'astra_verified',
  OCR_ASTRA_MODEL:'openai/gpt-6-astra',OCR_FABLE_MODEL:'anthropic/claude-fable-5.1',OPENROUTER_API_KEY:'mock-only-secret',
  GOOGLE_APPLICATION_CREDENTIALS:credentials,MONGO_URI:'mongodb://localhost/ordinary_dev',UPLOAD_BASE_PATH:'uploads'});
beforeAll(()=>{
  directory=fs.mkdtempSync(path.join(os.tmpdir(),'normal-ocr-config-'));credentials=path.join(directory,'account.json');
  fs.writeFileSync(credentials,JSON.stringify({type:'service_account',client_email:'mock@example.invalid',
    private_key:crypto.generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey}));
});
afterAll(()=>{fs.unlinkSync(credentials);fs.rmdirSync(directory);});
test.each([{}, {OCR_SOURCE_MODE:'legacy'}])('absent/explicit legacy never requires new credentials: %j',env=>{
  expect(validateOcrConfiguration(env)).toEqual({mode:'legacy'});
});
test('ordinary development accepts existing Astra mode without shadow ports, paths, users or flags',()=>{
  const env=configured();expect(mode(env)).toBe('astra_verified');
  expect(validateOcrConfiguration(env)).toEqual({mode:'astra_verified',astraModel:env.OCR_ASTRA_MODEL,fableModel:env.OCR_FABLE_MODEL,
    openrouterConfigured:true,googleConfigured:true});
  expect(JSON.stringify(validateOcrConfiguration(env))).not.toContain(env.OPENROUTER_API_KEY);
  expect(mode({...env,NODE_ENV:undefined})).toBe('astra_verified');
});
test.each(['OPENROUTER_API_KEY','OCR_ASTRA_MODEL','OCR_FABLE_MODEL','GOOGLE_APPLICATION_CREDENTIALS'])('missing %s fails clearly without fallback',field=>{
  expect(()=>validateOcrConfiguration({...configured(),[field]:''})).toThrow(/^OCR_/);
});
test('wrong model, unreadable/invalid Google credentials and invalid source mode fail closed',()=>{
  expect(()=>validateOcrConfiguration({...configured(),OCR_ASTRA_MODEL:'replacement'})).toThrow('CONFIGURATION_INVALID');
  expect(()=>validateOcrConfiguration({...configured(),GOOGLE_APPLICATION_CREDENTIALS:'/not-a-credential-file'})).toThrow('OCR_GOOGLE_CONFIGURATION_INVALID');
  expect(()=>validateOcrConfiguration({OCR_SOURCE_MODE:'unknown'})).toThrow('OCR_SOURCE_MODE_INVALID');
  expect(()=>validateOcrConfiguration({...configured(),NODE_ENV:'production'})).toThrow('LOCAL_ONLY');
});
test('staging publication still requires complete shadow isolation; legacy/shadow semantics preserved',()=>{
  const isolated={...require('../scripts/local-shadow/config.cjs').configuration(),OCR_SOURCE_MODE:'astra_verified',LOCAL_ASTRA_VERIFIED_OPT_IN:'true'};
  expect(mode(isolated)).toBe('astra_verified');expect(isolated.PORT).toBe('5001');
  expect(()=>mode({...isolated,MONGO_URI:'mongodb://remote/other'})).toThrow('LOCAL_ONLY');
  expect(mode({OCR_SOURCE_MODE:'hybrid_shadow'})).toBe('hybrid_shadow');
  expect(()=>mode({OCR_SOURCE_MODE:'hybrid'})).toThrow('NOT_VALIDATED');
});
test('ordinary dotenv process-over-file precedence is unchanged',()=>{
  const file=path.join(directory,'test.env');fs.writeFileSync(file,'OCR_SOURCE_MODE=legacy\nOCR_ASTRA_MODEL=from-file\n');
  const processEnv={OCR_SOURCE_MODE:'astra_verified'};
  require('dotenv').config({path:file,processEnv,quiet:true});
  expect(processEnv.OCR_SOURCE_MODE).toBe('astra_verified');expect(processEnv.OCR_ASTRA_MODEL).toBe('from-file');fs.unlinkSync(file);
  const loader=fs.readFileSync(path.join(__dirname,'../src/config/env.js'),'utf8');
  expect(loader).toContain("dotenv.config({ path: path.join(__dirname, '..', '..', '.env') })");
});
async function startup(valid=true){
  const connect=jest.fn(async()=>{}),listen=jest.fn((_port,_host,cb)=>{cb();return {}}),validate=jest.fn(()=>{
    if(!valid)throw Object.assign(Error('OCR_SOURCE_CONFIGURATION_INVALID'),{code:'OCR_SOURCE_CONFIGURATION_INVALID'});
    return validateOcrConfiguration(configured());
  });
  const logger={info:jest.fn(),warn:jest.fn(),error:jest.fn(),metric:jest.fn()};
  const modules={ './config/env':{PORT:5000,NODE_ENV:'development'},'./config/db':connect,'./utils/logger':logger,
    './services/aiGeneration.service':{validateAIConfig:()=>({isValid:true,chain:[]})},
    './services/pdfBrowserManager.service':{validateBrowserRuntime:jest.fn(),closeBrowser:jest.fn()},
    './services/runtimeContractFingerprint.service':{runtimeContractFingerprint:()=>({})},
    './services/aiGateway.service':{sanitizedAssessmentChain:()=>[]},'./app':{listen},
    './services/shutdown.service':{createShutdown:()=>jest.fn()},'./config/ocr':{validateOcrConfiguration:validate},
    './services/planEntitlementWorker.service':{startPlanEntitlementWorker:jest.fn()},
    './models/SourceFidelityEvidence':{createIndexes:jest.fn(async()=>{})},
    './models/SourceFidelitySnapshot':{createIndexes:jest.fn(async()=>{})}};
  const fakeProcess={env:{NODE_ENV:'development',ASSESSMENT_RECOVERY_ENABLED:'false'},on:jest.fn(),exit:jest.fn()};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8'),{
    require:name=>{if(!(name in modules))throw Error('UNMOCKED_STARTUP_DEPENDENCY');return modules[name];},process:fakeProcess});
  await new Promise(resolve=>setImmediate(resolve));return {connect,listen,validate,logger,process:fakeProcess};
}
test('actual normal startup validates before Mongo/workers and binds ordinary port 5000',async()=>{
  const r=await startup();expect(r.validate).toHaveBeenCalledTimes(1);expect(r.connect).toHaveBeenCalledTimes(1);
  expect(r.listen).toHaveBeenCalledWith(5000,'0.0.0.0',expect.any(Function));
  expect(r.logger.info).toHaveBeenCalledWith(expect.objectContaining({event:'ocr_source_configuration',mode:'astra_verified'}));
});
test('invalid startup config exits before database, workers or listener',async()=>{
  const r=await startup(false);expect(r.connect).not.toHaveBeenCalled();expect(r.listen).not.toHaveBeenCalled();expect(r.process.exit).toHaveBeenCalledWith(1);
});
test('normal ng serve stays on development and API 5000; isolated frontend remains separate',()=>{
  const angular=JSON.parse(fs.readFileSync(path.join(__dirname,'../../RoznaComarker/angular.json'))).projects['rozna-comarker-fe'].architect;
  expect(angular.serve.defaultConfiguration).toBe('development');
  expect(angular.serve.configurations.development.buildTarget).toBe('rozna-comarker-fe:build:development');
  expect(angular.build.configurations.development.fileReplacements).toBeUndefined();
  const frontend=fs.readFileSync(path.join(__dirname,'../../RoznaComarker/src/environments/environment.ts'),'utf8');
  expect(frontend).toContain("const backendOrigin = 'http://localhost:5000'");
  expect(angular.build.configurations['local-shadow'].fileReplacements[0].with).toContain('local-shadow');
});
