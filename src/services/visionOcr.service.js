const path = require('path');

const fs = require('fs');



const { ImageAnnotatorClient } = require('@google-cloud/vision');

const sizeOf = require('image-size');
const sharp = require('sharp');
const { createHash } = require('crypto');
const OCR_PIPELINE_VERSION = 'vision-normalized-evidence-v1';
const OCR_PREPROCESSING_VERSION = 'sharp-auto-orient-v1';



const logger = require('../utils/logger');
const { buildCanonicalPageFromWords, buildHandwritingGeometryTranscript, HANDWRITING_LAYOUT_VERSION } = require('../utils/ocrTranscriptNormalizer');
const READING_ORDER_DIAGNOSTICS=Symbol('privateGoogleReadingOrderDiagnostics');
const STUDENT_SOURCE_EVIDENCE=Symbol('privateLegacyStudentSourceEvidence');


function getBackendRootDir() {

  return path.resolve(__dirname, '..', '..');

}



function resolveCredentialsPathMaybe(rawPath) {

  if (!rawPath || typeof rawPath !== 'string') return null;

  const trimmed = rawPath.trim();

  if (!trimmed) return null;



  if (path.isAbsolute(trimmed)) return trimmed;



  const backendRoot = getBackendRootDir();

  const withoutDotSlash = trimmed.replace(/^\.[\\/]/, '');



  if (/^backend[\\/]/i.test(withoutDotSlash)) {

    return path.resolve(backendRoot, withoutDotSlash.replace(/^backend[\\/]/i, ''));

  }



  return path.resolve(backendRoot, trimmed);

}



function ensureGoogleCredentialsEnv() {

  const raw = process.env.GOOGLE_CLOUD_KEY_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS;

  const resolved = resolveCredentialsPathMaybe(raw);

  if (!resolved) return null;



  if (!fs.existsSync(resolved)) {
    throw new Error(

      `Google Vision credentials file not found at: ${resolved}. ` +

        'Set GOOGLE_CLOUD_KEY_FILE to the Vision service-account JSON path.'

    );

  }



  return resolved;

}



/**

 * Google Vision client

 * Credentials are loaded automatically from:

 * process.env.GOOGLE_CLOUD_KEY_FILE (preferred) or GOOGLE_APPLICATION_CREDENTIALS

 */

let visionClient;

function validateGoogleConfiguration(environment = process.env) {
  // Reuse exactly the runtime path resolution and precedence; inspect local
  // credential structure only. Do not instantiate a client or obtain a token.
  const file = resolveCredentialsPathMaybe(environment.GOOGLE_CLOUD_KEY_FILE || environment.GOOGLE_APPLICATION_CREDENTIALS);
  try {
    const account = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (account.type !== 'service_account' || typeof account.client_email !== 'string' || !account.client_email
      || typeof account.private_key !== 'string' || !account.private_key
      || (account.token_uri && account.token_uri !== 'https://oauth2.googleapis.com/token')) throw Error();
    require('crypto').createPrivateKey(account.private_key);
  } catch {
    throw Object.assign(new Error('OCR_GOOGLE_CONFIGURATION_INVALID'), { code: 'OCR_GOOGLE_CONFIGURATION_INVALID' });
  }
  return true;
}

function getVisionClient() {
  if (visionClient) return visionClient;
  const credentialsPath = ensureGoogleCredentialsEnv();
  visionClient = credentialsPath
    ? new ImageAnnotatorClient({ keyFilename: credentialsPath })
    : new ImageAnnotatorClient();
  return visionClient;
}



/* ------------------------- helpers ------------------------- */



function clampPercent(value) {

  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.max(0, Math.min(100, n));

}



function bboxFromVertices(vertices, width, height) {

  const pts = Array.isArray(vertices) ? vertices : [];

  // Protobuf JSON omits scalar fields whose value is zero. Missing x/y on an
  // otherwise valid vertex therefore means coordinate 0, not an invalid box.
  const xs = pts.map(v => Number(v && v.x != null ? v.x : 0)).filter(Number.isFinite);

  const ys = pts.map(v => Number(v && v.y != null ? v.y : 0)).filter(Number.isFinite);



  if (!xs.length || !ys.length) return null;

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {

    return null;

  }



  const minX = Math.min(...xs);

  const minY = Math.min(...ys);

  const maxX = Math.max(...xs);

  const maxY = Math.max(...ys);



  const x = clampPercent((minX / width) * 100);

  const y = clampPercent((minY / height) * 100);

  const w = clampPercent(((maxX - minX) / width) * 100);

  const h = clampPercent(((maxY - minY) / height) * 100);



  if (w <= 0 || h <= 0) return null;

  return { x, y, w, h };

}



function buildTranscriptFromWords(words) {
  const list = Array.isArray(words)
    ? words.filter(w => w && typeof w.id === 'string')
    : [];
  const built = buildCanonicalPageFromWords(list);
  return {
    text: built.text,
    spans: built.spans.map(({ wordId, word, start, end }) => ({
      id: wordId,
      page: word.page,
      start,
      end,
      bbox: word.bbox
    }))
  };
}


/* ------------------------- main OCR ------------------------- */

class OcrProviderError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'OcrProviderError';
    this.code = code;
    this.retryable = options.retryable === true;
    this.safeMessage = options.safeMessage || message;
    this.cause = options.cause;
  }
}

function classifyVisionError(error) {
  if (error instanceof OcrProviderError) return error;
  const status = Number(error?.code || error?.status || error?.statusCode);
  const message = String(error?.message || '').toLowerCase();
  if (status === 4 || status === 408 || status === 504 || /deadline|timed?\s*out|timeout/.test(message)) {
    return new OcrProviderError('OCR_PROVIDER_TIMEOUT', 'Google Vision OCR timed out.', {
      retryable: true, safeMessage: 'OCR provider timed out. Processing can be retried.', cause: error
    });
  }
  if (status === 8 || status === 429 || /quota|rate.?limit|resource exhausted/.test(message)) {
    return new OcrProviderError('OCR_PROVIDER_RATE_LIMITED', 'Google Vision OCR was rate limited.', {
      retryable: true, safeMessage: 'OCR provider is temporarily busy. Processing can be retried.', cause: error
    });
  }
  if ([7, 16, 401, 403].includes(status) || /credential|unauth|permission/.test(message)) {
    return new OcrProviderError('OCR_PROVIDER_AUTH', 'Google Vision OCR authentication failed.', {
      retryable: false, safeMessage: 'OCR service configuration is unavailable.', cause: error
    });
  }
  return new OcrProviderError('OCR_PROVIDER_FAILED', 'Google Vision OCR failed.', {
    retryable: status >= 500 || /network|econn|unavailable/.test(message),
    safeMessage: 'OCR provider could not process this file.', cause: error
  });
}

function requestTimeoutMs() {
  const configured = Number(process.env.GOOGLE_VISION_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 1000 ? Math.min(configured, 120000) : 30000;
}

let activeRequests = 0;
const waitingRequests = [];
async function withOcrSlot(run) {
  if (activeRequests >= 2) await new Promise((resolve, reject) => {
    const ready = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      const index = waitingRequests.indexOf(ready);
      if (index >= 0) waitingRequests.splice(index, 1);
      reject(new OcrProviderError('OCR_PROVIDER_TIMEOUT', 'OCR queue timed out.', {
        retryable: true, safeMessage: 'OCR processing is busy. Please retry.'
      }));
    }, 30000);
    waitingRequests.push(ready);
  });
  else activeRequests += 1;
  try { return await run(); }
  finally {
    const next = waitingRequests.shift();
    if (next) next(); else activeRequests -= 1;
  }
}
async function detectDocument(image, dimensions, pageOffset = 0, pdfPage = false, captureSource = false, sourceReader = false, handwriting = false) {
  let result;
  try {
    const languageHints=!sourceReader?(process.env.OCR_LANGUAGE_HINTS||'').split(',').map(s=>s.trim()).filter(Boolean):[];
    [result] = await withOcrSlot(() => getVisionClient().documentTextDetection({ image,...(languageHints.length?{imageContext:{languageHints}}:{}) }, {
      timeout: pdfPage ? Math.min(requestTimeoutMs(), 30000) : requestTimeoutMs(),
      ...((pdfPage || sourceReader) ? { retry: null } : {})
    }));
  } catch (error) {
    throw classifyVisionError(error);
  }

  const annotation = result?.fullTextAnnotation || null;
  const pages = Array.isArray(annotation?.pages) ? annotation.pages : [];
  const words = [];
  const outputPages = [];
  const sourcePages = [];
  const handwritingPages=[];
  let paragraphIndex = 0;
  for (let pIndex = 0; pIndex < Math.max(1, pages.length); pIndex += 1) {
    const page = pages[pIndex] || {};
    const pageNumber = pageOffset + pIndex + 1;
    const width = dimensions.width;
    const height = dimensions.height;
    if ((Number.isFinite(Number(page.width)) && Math.abs(Number(page.width) - width) > 1)
      || (Number.isFinite(Number(page.height)) && Math.abs(Number(page.height) - height) > 1)) {
      logger.warn({ event: 'ocr_page_dimensions_mismatch', width, height,
        reportedWidth: Number(page.width), reportedHeight: Number(page.height), pageNumber });
    }
    let pageWordIndex = 0;
    const pageWords = [];
    const sourceWords = [];
    const allPageWords=[];
    for (const block of page.blocks || []) {
      for (const para of block.paragraphs || []) {
        paragraphIndex += 1;
        for (const word of para.words || []) {
          const literal = (word.symbols || []).map(symbol => symbol?.text || '').join('');
          const text = handwriting?literal:literal.trim();
          if (!text) continue;
          const vertices=word.boundingBox?.vertices;
          const usableVertices=handwriting&&Array.isArray(vertices)?vertices.filter(v=>v&&[v.x??0,v.y??0].every(n=>typeof n==='number'&&Number.isFinite(n))):vertices;
          const validVertices=!handwriting||Array.isArray(usableVertices)&&usableVertices.length>=3;
          const bbox = validVertices?bboxFromVertices(usableVertices, width, height):null;
          if (!bbox&&!handwriting)continue;
          pageWordIndex += 1;
          const normalized = { id: `word_${pageNumber}_${pageWordIndex}`, page: pageNumber,
            paragraphIndex, text,
            confidence: Math.min(...(word.symbols || []).map(symbol => Number(symbol?.confidence)).filter(Number.isFinite), 1),
            bbox };
          words.push(normalized);
          pageWords.push(normalized);
          if(handwriting)allPageWords.push(normalized);
          if (captureSource) sourceWords.push({ nativeId: normalized.id, text,
            paragraphIndex, confidence: normalized.confidence,
            polygon: (word.boundingBox?.vertices || []).map(p => ({ x: p.x || 0, y: p.y || 0 })),
            symbols: (word.symbols || []).map(s => ({ text: s.text || '',
              confidence: Number.isFinite(s.confidence) ? s.confidence : null,
              breakType: s.property?.detectedBreak?.type || null,
              polygon: (s.boundingBox?.vertices || []).map(p => ({ x: p.x || 0, y: p.y || 0 })) })) });
        }
      }
    }
    outputPages.push({ pageNumber, width, height, coordinateSpace: 'display-image',
      ocrImageWidth: width, ocrImageHeight: height, ocrExifOrientation: dimensions.ocrExifOrientation || 1,
      words: pageWords.map(word => ({
      id: word.id, text: word.text, bbox: word.bbox, paragraphIndex: word.paragraphIndex, confidence: word.confidence
    })), lines: [] });
    if(handwriting){
      const built=buildHandwritingGeometryTranscript(allPageWords);
      if(built.layoutDegraded||Number(page.width)!==width||Number(page.height)!==height){
        const invalidPage=Number(page.width)!==width||Number(page.height)!==height;
        const reasonCode=invalidPage?'INVALID_PAGE_GEOMETRY':built.reason;
        const stats=Object.fromEntries(['detectedWordCount','geometricWordCount','rawGeometryCoverage','resolvedWordCount','resolvedPlacementCoverage',
          'fallbackPlacementCount','ambiguousWordCount','unresolvedWordCount','lineCount','medianWordHeight'].map(k=>[k,built[k]]));
        if(invalidPage)Object.assign(stats,{resolvedWordCount:0,resolvedPlacementCoverage:0,unresolvedWordCount:allPageWords.length});
        const unresolvedDescriptors=invalidPage?allPageWords.slice(0,20).map((w,inputIndex)=>({inputIndex,textLength:w.text.length,hasGeometry:!!w.bbox,candidateLineCount:0,reason:reasonCode})):built.unresolvedDescriptors;
        if(process.env.NODE_ENV==='development')try{logger.info({event:'ocr_handwriting_layout_rejected',reasonCode,...stats,unresolvedDescriptors});}catch{/* Diagnostics never change acceptance. */}
        const error=new OcrProviderError('OCR_READING_ORDER_UNRELIABLE','Handwriting line order could not be established.',{
          safeMessage:'The page layout could not be read reliably. Please upload a clearer image.'});
        Object.defineProperty(error,READING_ORDER_DIAGNOSTICS,{value:{nativeGoogleText:annotation?.text||'',geometryTranscript:'',geometryCoverage:built.geometryCoverage,lineCount:built.lineCount,readingOrderStrategy:HANDWRITING_LAYOUT_VERSION,reasonCode,...stats,unresolvedDescriptors,soleCandidateOutlierPlacementCount:built.soleCandidateOutlierPlacementCount}});
        throw error;
      }
      Object.assign(outputPages.at(-1),{text:built.text,rawText:built.text,ocrPipelineVersion:HANDWRITING_LAYOUT_VERSION});
      handwritingPages.push(built);
    }
    if (captureSource) sourcePages.push({ pageNumber, width, height, words: sourceWords,
      dimensionsMatch: Number(page.width) === width && Number(page.height) === height });
  }
  const { text: transcriptText, spans } = buildTranscriptFromWords(words);
  const detected = { fullText: annotation?.text || transcriptText, transcriptText, words, spans, pages: outputPages };
  if(handwriting){
    detected.fullText=detected.transcriptText=handwritingPages.map(p=>p.text).join('\n\n');
    let offset=0;detected.spans=handwritingPages.flatMap(p=>{const spans=p.spans.map(s=>({...s,start:s.start+offset,end:s.end+offset}));offset+=p.text.length+2;return spans;});
    detected.ocrPipelineVersion=HANDWRITING_LAYOUT_VERSION;
    const totals=Object.fromEntries(['detectedWordCount','geometricWordCount','resolvedWordCount','fallbackPlacementCount','soleCandidateOutlierPlacementCount','ambiguousWordCount','unresolvedWordCount'].map(k=>[k,handwritingPages.reduce((n,p)=>n+p[k],0)]));
    Object.defineProperty(detected,READING_ORDER_DIAGNOSTICS,{value:{nativeGoogleText:annotation?.text||'',geometryTranscript:detected.transcriptText,
      geometryCoverage:handwritingPages.map(p=>p.geometryCoverage),...totals,rawGeometryCoverage:totals.geometricWordCount/totals.detectedWordCount,
      resolvedPlacementCoverage:totals.resolvedWordCount/totals.detectedWordCount,lineCount:handwritingPages.reduce((n,p)=>n+p.lineCount,0),readingOrderStrategy:HANDWRITING_LAYOUT_VERSION}});
  }
  if (captureSource) Object.defineProperty(detected, require('./hybridSource/shadow').rawEvidence,
    { value: sourcePages });
  return detected;
}

function detectWithShadow(bytes, dimensions, pageOffset, pdfPage, options, sourceSha256, mimeType) {
  const selected = require('./hybridSource/contract').mode();
  if(selected==='gpt_vision_exact')return require('./gptVisionExact.service').readPage({bytes,mimeType,
    identity:{...options.hybridIdentity,fileId:String(options.sourceFile?._id||''),fileOrder:options.fileOrder||0,
      pageNumber:pageOffset+1,pageIndex:pageOffset,sourceSha256,width:dimensions.width,height:dimensions.height},
    ...(options.hybridIdentity?{reservation:require('./gptVisionExact/preflight').claimReservation(options.sourceFile||{},options.hybridIdentity)}:{}),
    assignment:options.sourceAssignment,google:async()=>{
      const geometry=await detectDocument({content:bytes},dimensions,pageOffset,pdfPage,true,true);
      return geometry[require('./hybridSource/shadow').rawEvidence]?.every(p=>p.dimensionsMatch===true)?geometry:null;
    },
    isCurrentJob:options.isCurrentJob,signal:options.signal}).then(result=>{
      result.pages.forEach(page=>Object.assign(page,{width:dimensions.width,height:dimensions.height,pageNumber:pageOffset+1}));return result;
    });
  if (['astra_verified','astra_human_confirm'].includes(selected)) {
    return require('./sourceFidelityOcr.service').readPage({bytes,mimeType,
      identity:{...options.hybridIdentity,fileId:String(options.sourceFile?._id||''),fileOrder:options.fileOrder||0,
        pageNumber:pageOffset+1,pageIndex:pageOffset,sourceSha256,width:dimensions.width,height:dimensions.height},
      google:()=>detectDocument({content:bytes},dimensions,pageOffset,pdfPage,true,true),
      isCurrentJob:options.isCurrentJob,signal:options.signal,targetedBudget:options.targetedBudget}).then(result=>{
        result.pages.forEach(page=>Object.assign(page,result.source,{width:dimensions.width,height:dimensions.height,
          pageNumber:pageOffset+1,text:result.fullText,rawText:result.fullText}));return result;
      });
  }
  const order=process.env.OCR_READING_ORDER||(!pdfPage?'handwriting_geometry':'native');
  if(selected==='legacy'&&!['handwriting_geometry','native'].includes(order))throw new OcrProviderError('OCR_READING_ORDER_CONFIGURATION_INVALID','Invalid OCR reading order configuration.');
  const google = detectDocument({ content: bytes }, dimensions, pageOffset, pdfPage, selected === 'hybrid_shadow',false,selected==='legacy'&&order==='handwriting_geometry');
  if (selected === 'hybrid_shadow' && options.hybridIdentity) {
    require('./hybridSource/shadow').observe({ bytes, mimeType, google,
      identity: { ...options.hybridIdentity, fileId: String(options.sourceFile?._id || ''),
        pageNumber: pageOffset + 1, sourceSha256,
        inputSha256: createHash('sha256').update(bytes).digest('hex'),
        width: dimensions.width, height: dimensions.height, orientation: dimensions.ocrExifOrientation || 1 },
      isCurrentJob: options.isCurrentSourceRun || options.isCurrentJob });
  }
  if(selected==='legacy'&&order==='handwriting_geometry')return google.then(async detected=>{
    const page=detected.pages[0];
    // Finalize occurrence IDs before selection so active and excluded evidence
    // refer to the same IDs that persistence/canonical reconstruction retain.
    const fileId=String(options.sourceFile?._id||'legacy'),ids=new Map(detected.words.map((w,i)=>[w.id,`word_${fileId}_${pageOffset+1}_${i+1}`]));
    const spans=detected.spans.map(s=>({...s,wordId:ids.get(s.wordId),word:{...s.word,id:ids.get(s.wordId)}}));
    const selectedSource=await require('../utils/legacyStudentSource').selectStudentSource({bytes,spans,assignment:options.sourceAssignment||{}});
    Object.assign(detected,{fullText:selectedSource.text,transcriptText:selectedSource.text,words:selectedSource.words,spans:selectedSource.spans,
      studentSourceVersion:selectedSource.version,studentSourceTextSha256:selectedSource.textSha256});
    Object.assign(page,{text:selectedSource.text,rawText:selectedSource.text,words:selectedSource.words,
      studentSourceVersion:selectedSource.version,studentSourceTextSha256:selectedSource.textSha256});
    Object.defineProperty(detected,STUDENT_SOURCE_EVIDENCE,{value:selectedSource.evidence});return detected;
  });
  return google;
}



async function extractOcrFromImageFile(absoluteFilePath, options = {}) {
  const sourceMode = require('./hybridSource/contract').mode();

  if (!absoluteFilePath || typeof absoluteFilePath !== 'string') {

    throw new Error('Missing file path');

  }



  if (!fs.existsSync(absoluteFilePath)) {

    throw new Error(`File not found: ${absoluteFilePath}`);

  }



  const ext = path.extname(absoluteFilePath).toLowerCase();

  if (ext === '.pdf') {

    let rasterized;
    try {
      rasterized = await require('./pdfSubmissionPages.service').preparePdfPages(absoluteFilePath, options.sourceFile, options);
    } catch (error) {
      if (error?.code?.startsWith('OCR_')) throw error;
      throw new OcrProviderError('OCR_UNSUPPORTED_FORMAT', 'PDF could not be rasterized for OCR.', {
        safeMessage: 'This PDF could not be read. It may be corrupt, protected, or too large.', cause: error
      });
    }
    options.reservePages?.(rasterized.length);
    const detectedPages = [];
    const pdfSourceSha = ['hybrid_shadow','astra_verified','astra_human_confirm','gpt_vision_exact'].includes(sourceMode)
      ? createHash('sha256').update(await fs.promises.readFile(absoluteFilePath)).digest('hex') : null;
    for (let index = 0; index < rasterized.length; index += 1) {
      if (options.isCurrentJob && !(await options.isCurrentJob())) {
        throw new OcrProviderError('OCR_JOB_SUPERSEDED', 'This assessment has been replaced.');
      }
      const page = rasterized[index];
      const detected = await detectWithShadow(page.buffer, {
        width: page.width, height: page.height
      }, index, true, options, pdfSourceSha, ['astra_verified','astra_human_confirm','gpt_vision_exact'].includes(sourceMode) ? 'image/jpeg' : 'image/png');
      // Each raster produces one canonical page, including blank pages. Never
      // copy the combined document text into every page's semantic transcript.
      const resultPage = detected.pages[0];
      Object.assign(resultPage, { text: detected.fullText, rawText: detected.fullText,
        width: page.width, height: page.height, derivedImageFileId: page.derivedImageFileId,
        pageImageUrl: page.pageImageUrl, rasterHash: page.rasterHash,
        rasterizationVersion: page.rasterizationVersion });
      detectedPages.push({ ...detected, pages: [resultPage] });
    }
    const pages = detectedPages.flatMap(result => result.pages);
    const words = detectedPages.flatMap(result => result.words);
    const fullText = detectedPages.map(result => result.fullText).filter(Boolean).join('\n\n');
    const transcriptText = detectedPages.map(result => result.transcriptText).filter(Boolean).join('\n\n');
    return { fullText, transcriptText, words, pages,
      ...(detectedPages.some(r=>r[STUDENT_SOURCE_EVIDENCE])?{[STUDENT_SOURCE_EVIDENCE]:{byPage:Object.fromEntries(detectedPages.map(r=>[r.pages[0].pageNumber,r[STUDENT_SOURCE_EVIDENCE]]))}}:{}),
      spans: detectedPages.flatMap(result => result.spans || []) };

  }



  let dims;
  try { dims = sizeOf(absoluteFilePath); }
  catch (error) {
    throw new OcrProviderError('OCR_INVALID_IMAGE_DIMENSIONS', 'Unable to determine image dimensions.', {
      safeMessage: 'The uploaded image is corrupt or has unsupported dimensions.', cause: error
    });
  }

  const width = dims?.width;

  const height = dims?.height;



  if (!width || !height) {

    throw new OcrProviderError('OCR_INVALID_IMAGE_DIMENSIONS', 'Unable to determine image dimensions.', {
      safeMessage: 'The uploaded image is corrupt or has unsupported dimensions.'
    });

  }
  options.reservePages?.(1);
  // Normalize only the in-memory OCR input, never the stored student source.
  let normalized;
  let sourceBytes;
  try {
    sourceBytes = await fs.promises.readFile(absoluteFilePath);
    if(sourceMode==='gpt_vision_exact')normalized=await require('./gptVisionExact/imageInput').orientImage(sourceBytes);
    else normalized = await sharp(sourceBytes, { failOn: 'error' })
      .rotate().toBuffer({ resolveWithObject: true });
  } catch (error) {
    throw new OcrProviderError('OCR_INVALID_IMAGE_DIMENSIONS', 'Unable to normalize the uploaded image.', {
      safeMessage: 'The uploaded image could not be decoded.', cause: error });
  }
  const result = await detectWithShadow(normalized.data, { width: normalized.info.width,
    height: normalized.info.height, ocrExifOrientation: dims.orientation || 1 }, 0, false, options,
    createHash('sha256').update(sourceBytes).digest('hex'),
    normalized.info.format === 'jpeg' ? 'image/jpeg' : `image/${normalized.info.format}`);
  const provenance = { sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'),
    ocrInputSha256: createHash('sha256').update(normalized.data).digest('hex'),
    encodedImageWidth: width, encodedImageHeight: height,
    sourceMimeType: dims.type === 'jpg' ? 'image/jpeg' : `image/${dims.type}`,
    ocrProvider: ['astra_human_confirm','gpt_vision_exact'].includes(sourceMode)?'openrouter':'google_vision', ocrApi: ['astra_human_confirm','gpt_vision_exact'].includes(sourceMode)?'source_fidelity_v1':'documentTextDetection',
    ocrPipelineVersion: result.ocrPipelineVersion||OCR_PIPELINE_VERSION, ocrPreprocessingVersion: OCR_PREPROCESSING_VERSION };
  result.pages.forEach(page => Object.assign(page, provenance));
  return result;

}



/* ------------------------- exports ------------------------- */



// Preflight uses the same configured client, request slots and error mapping.
// Keep raw ordered polygons; normal assessment geometry remains unchanged.
async function detectOrientationAnnotation(content) {
  try {
    const [result] = await withOcrSlot(() => getVisionClient().documentTextDetection(
      { image: { content } }, { timeout: requestTimeoutMs(), retry: null }));
    if (result?.error?.message) throw new Error('Orientation provider response error');
    return result?.fullTextAnnotation || null;
  } catch (error) { throw classifyVisionError(error); }
}

module.exports = {
  STUDENT_SOURCE_EVIDENCE,
  READING_ORDER_DIAGNOSTICS,
  validateGoogleConfiguration,
  detectOrientationAnnotation,

  extractOcrFromImageFile,
  buildTranscriptFromWords,
  bboxFromVertices,
  classifyVisionError,
  OcrProviderError

};
